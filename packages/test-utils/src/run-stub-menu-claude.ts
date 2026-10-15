import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * One menu the stand-in shows: its text lines, its options, its kind, and
 * the item the cursor starts on, the first when absent. `numbered` draws
 * `1. Yes`, `plain` draws the label alone, and `boxes` draws `[✔] name` for
 * each option, ticked as `checked` holds, with `submit` as a last item
 * without a box. `window` draws only that many options at a time, as Claude
 * Code's lists do: `↑` and `↓` in the cursor's column beside the first and
 * last rows mark options out of view, except on the cursor's own row; the
 * list scrolls one row when the cursor moves onto its top row or past its
 * bottom row; and the arrows wrap from the first option to the last and
 * back, except that the down arrow on the last option of a box menu moves
 * to `submit`.
 */
const STUB_MENU_SCHEMA = z.object({
  kind: z.enum(['numbered', 'plain', 'boxes']),
  text: z.array(z.string()).readonly(),
  options: z.array(z.string()).readonly(),
  checked: z.array(z.boolean()).readonly().optional(),
  submit: z.string().optional(),
  cursor: z.number().optional(),
  window: z.number().optional(),
});

type StubMenu = Readonly<z.output<typeof STUB_MENU_SCHEMA>>;

/**
 * What the stand-in runs: its menus in order, the file whose arrival moves
 * it from the first menu to the second, the file whose arrival makes it
 * exit without printing anything, and the hold of its first menu, as
 * Claude Code holds a dialog that has just opened. During the hold the
 * arrows move the cursor, while Enter and Escape do nothing and restart the
 * hold. When the hold ends, the cursor goes back to where it started.
 * `enterDelayMs` makes the stand-in answer each Enter only that long after
 * it reads the key, as a busy agent does.
 */
const STUB_MENU_SPEC_SCHEMA = z.object({
  menus: z.array(STUB_MENU_SCHEMA),
  switchFile: z.string().optional(),
  exitFile: z.string().optional(),
  holdMs: z.number().optional(),
  enterDelayMs: z.number().optional(),
});

const KEY_NAMES: Readonly<Record<string, string>> = {
  '\u001B[A': 'up',
  '\u001B[B': 'down',
  '\r': 'enter',
  '\u001B': 'escape',
};

/**
 * A stand-in `claude` that waits on a menu the way Claude Code's dialogs
 * draw one: a rule, the text, then the options with a `❯` cursor. The up
 * and down arrows move the cursor without wrapping, Enter
 * picks the option under it or ticks and clears a box, and Escape dismisses
 * the menu. Arguments: the spec file and the log file; it ignores the rest,
 * such as the flags atc adds to a Claude launch. Each key it reads appends
 * `{ "key": name }` to the log, and each outcome appends `{ "picked":
 * label }`, `{ "toggled": label, "checked": bool }`, `{ "enabled": [...] }`
 * or `{ "dismissed": true }`. It stays up after the outcome until killed.
 */
function main() {
  const [specPath, logPath] = process.argv.slice(2);

  if (specPath === undefined || logPath === undefined) {
    throw new Error('usage: run-stub-menu-claude.ts <spec path> <log path>');
  }

  const spec = STUB_MENU_SPEC_SCHEMA.parse(JSON.parse(readFileSync(specPath, 'utf8')));
  const [first, second] = spec.menus;

  if (first === undefined) {
    throw new Error('the spec holds no menu');
  }

  const state = {
    menu: first,
    cursor: first.cursor ?? 0,
    top: findWindowTop(first, first.cursor ?? 0),
    checked: [...(first.checked ?? [])],
    open: true,
    held: (spec.holdMs ?? 0) > 0,
    holdUntil: Date.now() + (spec.holdMs ?? 0),
  };

  const log = (entry: Readonly<Record<string, unknown>>) => {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  };

  const draw = () => {
    process.stdout.write(
      `\u001B[2J\u001B[H${renderMenu(state.menu, state.cursor, state.top, state.checked)}`,
    );
  };

  const drawOutcome = (line: string, entry: Readonly<Record<string, unknown>>) => {
    state.open = false;

    log(entry);

    process.stdout.write(`\u001B[2J\u001B[H${line}\r\n`);
  };

  process.stdin.setRawMode(true);

  const answerKey = (data: string) => {
    if (!state.open) {
      return;
    }

    if (state.held && (data === '\r' || data === '\u001B')) {
      state.holdUntil = Date.now() + (spec.holdMs ?? 0);

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

      log({ toggled: label, checked: state.checked[state.cursor] });
      draw();
    } else if (data === '\r' && state.menu.kind === 'boxes') {
      const enabled = state.menu.options.filter((_, index) => state.checked[index] === true);

      drawOutcome(`Enabled: ${enabled.join(', ')}`, { enabled });
    } else if (data === '\r') {
      const label = state.menu.options[state.cursor] ?? '';

      drawOutcome(`Picked: ${label}`, { picked: label });
    }
  };

  process.stdin.on('data', (chunk: Buffer) => {
    const data = chunk.toString('utf8');

    log({ key: KEY_NAMES[data] ?? data });

    // An Enter that arrives during the hold is refused at once, so the hold
    // ending before the delay passes never lets it through.
    if (data === '\r' && spec.enterDelayMs !== undefined && !state.held) {
      setTimeout(() => {
        answerKey(data);
      }, spec.enterDelayMs);
    } else {
      answerKey(data);
    }
  });

  const holdTimer = setInterval(() => {
    if (state.held && Date.now() >= state.holdUntil) {
      clearInterval(holdTimer);

      state.held = false;
      state.cursor = first.cursor ?? 0;
      state.top = findWindowTop(first, state.cursor);

      if (state.open) {
        draw();
      }
    }
  }, 20);

  const exitFile = spec.exitFile;

  if (exitFile !== undefined) {
    setInterval(() => {
      if (existsSync(exitFile)) {
        process.exit(0);
      }
    }, 20);
  }

  const switchFile = spec.switchFile;

  if (switchFile !== undefined && second !== undefined) {
    const timer = setInterval(() => {
      if (existsSync(switchFile)) {
        clearInterval(timer);

        state.menu = second;
        state.cursor = second.cursor ?? 0;
        state.top = findWindowTop(second, state.cursor);
        state.checked = [...(second.checked ?? [])];

        draw();
      }
    }, 20);
  }

  draw();
  setInterval(() => {}, 60_000);
}

// The first option a windowed menu shows when its cursor starts on
// `cursor`: the top of the list, or the row that puts the cursor last.
function findWindowTop(menu: StubMenu, cursor: number): number {
  const size = menu.window ?? menu.options.length;

  return Math.max(0, Math.min(cursor, menu.options.length - 1) - size + 1);
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

main();
