import type { StubMemoryHarness } from './build-stub-memory-provider';

interface StubMenu {
  readonly kind: 'numbered' | 'plain' | 'boxes';
  readonly text: readonly string[];
  readonly options: readonly string[];
  readonly checked?: readonly boolean[];
  readonly submit?: string;
  readonly cursor?: number;
  readonly window?: number;
}

interface StubMenuScenario {
  readonly menus: readonly [StubMenu, ...StubMenu[]];

  // Held as Claude Code holds a dialog that just opened: arrows move the cursor,
  // enter and escape do nothing but restart the hold, and the cursor goes back
  // to its start when the hold ends.
  readonly holdMs?: number;

  // Answers each enter only that long after reading it, as a busy agent does.
  readonly enterDelayMs?: number;
  readonly pickOpensNext?: boolean;
}

interface StubMenuClaude {
  // Every key the stand-in read and every outcome it reached, in order.
  readonly log: Readonly<Record<string, unknown>>[];

  // Sets the menus the next session the daemon starts shows.
  readonly load: (scenario: StubMenuScenario) => void;

  // Runs the stand-in on a harness the daemon started.
  readonly start: (harness: StubMemoryHarness) => void;

  // Opens the second menu of the scenario in the latest session, as when the
  // agent moves on by itself.
  readonly switchMenu: () => void;

  // Ends the latest session with exit code 0.
  readonly exit: () => void;
}

export function buildStubMenuClaude(): StubMenuClaude {
  const log: Readonly<Record<string, unknown>>[] = [];
  const sessions: { harness: StubMemoryHarness; open: (menu: StubMenu) => void }[] = [];
  let loaded: StubMenuScenario | null = null;

  const readLatest = () => {
    const latest = sessions.at(-1);

    if (latest === undefined) {
      throw new Error('the stand-in runs no session');
    }

    return latest;
  };

  return {
    log,
    load: (scenario) => {
      loaded = scenario;
    },
    start: (harness) => {
      // A session started before any scenario sits idle, as another agent
      // on the same provider does.
      if (loaded === null) {
        return;
      }

      sessions.push({ harness, open: runStubMenuSession(harness, loaded, log) });
    },
    switchMenu: () => {
      const latest = readLatest();
      const second = loaded?.menus[1];

      if (second === undefined) {
        throw new Error('the scenario holds no second menu');
      }

      latest.open(second);
    },
    exit: () => {
      readLatest().harness.emitExit({ exitCode: 0 });
    },
  };
}

const KEY_NAMES: Readonly<Record<string, string>> = {
  '\u001B[A': 'up',
  '\u001B[B': 'down',
  '\r': 'enter',
  '\u001B': 'escape',
};

// Draws the first menu and answers keys as Claude Code's dialogs do, and
// returns how to open another menu in the session.
function runStubMenuSession(
  harness: StubMemoryHarness,
  scenario: StubMenuScenario,
  log: Readonly<Record<string, unknown>>[],
): (menu: StubMenu) => void {
  const [first, second] = scenario.menus;
  const holdMs = scenario.holdMs ?? 0;

  const timers = new Set<ReturnType<typeof setTimeout>>();

  const state = {
    menu: first,
    cursor: first.cursor ?? 0,
    top: getWindowTop(first, first.cursor ?? 0),
    checked: [...(first.checked ?? [])],
    open: true,
    holdUntil: Date.now() + holdMs,
  };

  // A terminal's output reaches its reader after the write that caused it,
  // never inside it.
  const schedule = (run: () => void, delayMs: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);

      if (harness.readExit() === null && !harness.isDetached()) {
        run();
      }
    }, delayMs);

    timers.add(timer);
  };

  harness.onExit(() => {
    for (const timer of timers) {
      clearTimeout(timer);
    }

    timers.clear();
  });

  const draw = () => {
    const screen = renderMenu(state.menu, state.cursor, state.top, state.checked);

    schedule(() => {
      harness.emitData(`\u001B[2J\u001B[H${screen}`);
    }, 0);
  };

  const scheduleHoldEnd = () => {
    if (holdMs === 0) {
      return;
    }

    schedule(
      () => {
        if (Date.now() < state.holdUntil) {
          scheduleHoldEnd();

          return;
        }

        state.cursor = first.cursor ?? 0;
        state.top = getWindowTop(first, state.cursor);

        if (state.open) {
          draw();
        }
      },
      Math.max(0, state.holdUntil - Date.now()),
    );
  };

  const openMenu = (menu: StubMenu) => {
    state.menu = menu;
    state.cursor = menu.cursor ?? 0;
    state.top = getWindowTop(menu, state.cursor);
    state.checked = [...(menu.checked ?? [])];
    state.open = true;

    draw();
  };

  const drawOutcome = (line: string, entry: Readonly<Record<string, unknown>>) => {
    state.open = false;

    log.push(entry);

    schedule(() => {
      harness.emitData(`\u001B[2J\u001B[H${line}\r\n`);
    }, 0);
  };

  const answerKey = (data: string) => {
    if (!state.open) {
      return;
    }

    if (Date.now() < state.holdUntil && (data === '\r' || data === '\u001B')) {
      state.holdUntil = Date.now() + holdMs;

      return;
    }

    const items = state.menu.options.length + (state.menu.submit === undefined ? 0 : 1);

    if (data === '\u001B[A' && state.menu.window !== undefined) {
      Object.assign(state, planWindowUp(state.menu, state.cursor, state.top));

      draw();
    } else if (data === '\u001B[B' && state.menu.window !== undefined) {
      Object.assign(state, planWindowDown(state.menu, state.cursor, state.top));

      draw();
    } else if (data === '\u001B[A') {
      state.cursor = Math.max(0, state.cursor - 1);

      draw();
    } else if (data === '\u001B[B') {
      state.cursor = Math.min(items - 1, state.cursor + 1);

      draw();
    } else if (data === '\u001B') {
      drawOutcome('Dismissed', { dismissed: true });
    } else if (
      data === '\r' &&
      state.menu.kind === 'boxes' &&
      state.cursor < state.menu.options.length
    ) {
      const label = state.menu.options[state.cursor] ?? '';

      state.checked[state.cursor] = state.checked[state.cursor] !== true;

      log.push({ toggled: label, checked: state.checked[state.cursor] });

      draw();
    } else if (data === '\r' && state.menu.kind === 'boxes') {
      const enabled = state.menu.options.filter((_, index) => state.checked[index] === true);

      drawOutcome(`Enabled: ${enabled.join(', ')}`, { enabled });
    } else if (data === '\r') {
      const label = state.menu.options[state.cursor] ?? '';

      if (scenario.pickOpensNext === true && second !== undefined && state.menu === first) {
        log.push({ picked: label });

        openMenu(second);
      } else {
        drawOutcome(`Picked: ${label}`, { picked: label });
      }
    }
  };

  harness.onInput((data) => {
    log.push({ key: KEY_NAMES[data] ?? data });

    // An Enter that arrives during the hold is refused at once, so the hold
    // ending before the delay passes never lets it through.
    if (data === '\r' && scenario.enterDelayMs !== undefined && Date.now() >= state.holdUntil) {
      schedule(() => {
        answerKey(data);
      }, scenario.enterDelayMs);
    } else {
      answerKey(data);
    }
  });

  draw();
  scheduleHoldEnd();

  return openMenu;
}

// The first option a windowed menu shows when its cursor starts on
// `cursor`: the top of the list, or the row that puts the cursor last.
function getWindowTop(menu: StubMenu, cursor: number): number {
  const size = menu.window ?? menu.options.length;

  return Math.max(0, Math.min(cursor, menu.options.length - 1) - size + 1);
}

function renderMenu(
  menu: StubMenu,
  cursor: number,
  top: number,
  checked: readonly boolean[],
): string {
  const size = menu.window ?? menu.options.length;
  const shown = menu.options.slice(top, top + size);

  const rows = shown.map((label, row) => {
    const index = top + row;

    const pointer = renderPointer(index === cursor, {
      above: row === 0 && top > 0,
      below: row === shown.length - 1 && top + size < menu.options.length,
    });

    if (menu.kind === 'numbered') {
      return ` ${pointer}${index + 1}. ${label}`;
    }

    if (menu.kind === 'boxes') {
      return ` ${pointer}[${checked[index] === true ? '✔' : ' '}] ${label}`;
    }

    return ` ${pointer}${label}`;
  });

  if (menu.submit !== undefined) {
    rows.push(` ${cursor === menu.options.length ? '❯ ' : '  '}    ${menu.submit}`);
  }

  return [
    '─'.repeat(60),
    ...menu.text.map((line) => ` ${line}`),
    '',
    ...rows,
    '',
    ' Enter to confirm · Esc to cancel',
  ].join('\r\n');
}

// Whether one row of a windowed menu sits beside options out of view.
interface RowMarks {
  readonly above: boolean;
  readonly below: boolean;
}

// The cursor's column of one row: the cursor, else the mark of options out
// of view beside that row, else blank.
function renderPointer(isCursor: boolean, more: RowMarks): string {
  if (isCursor) {
    return '❯ ';
  }

  if (more.below) {
    return '↓ ';
  }

  return more.above ? '↑ ' : '  ';
}

// Where a windowed menu's cursor sits, and the first option it shows.
interface WindowState {
  readonly cursor: number;
  readonly top: number;
}

// The cursor and the window's first option after the up arrow.
function planWindowUp(menu: StubMenu, cursor: number, top: number): WindowState {
  const size = menu.window ?? menu.options.length;
  const last = menu.options.length - 1;

  if (cursor > last) {
    return { cursor: last, top: Math.max(top, last - size + 1) };
  }

  if (cursor === 0) {
    return { cursor: last, top: Math.max(0, last - size + 1) };
  }

  return { cursor: cursor - 1, top: cursor - 1 <= top ? Math.max(0, top - 1) : top };
}

// The cursor and the window's first option after the down arrow.
function planWindowDown(menu: StubMenu, cursor: number, top: number): WindowState {
  const size = menu.window ?? menu.options.length;
  const last = menu.options.length - 1;

  if (cursor > last) {
    return { cursor, top };
  }

  if (cursor === last) {
    return menu.kind === 'boxes' && menu.submit !== undefined
      ? { cursor: last + 1, top }
      : { cursor: 0, top: 0 };
  }

  return { cursor: cursor + 1, top: cursor + 1 >= top + size ? cursor + 2 - size : top };
}
