import { systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import { machineTypes } from '@zgeoff/std';
import { createActor, enqueueActions, raise, setup } from 'xstate';
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

  // Claude Code holds a dialog that just opened: enter and escape only restart the hold.
  readonly holdMs?: number;

  // Answers each enter only that long after reading it, as a busy agent does.
  readonly enterDelayMs?: number;
  readonly pickOpensNext?: boolean;
}

interface StubMenuClaude {
  readonly log: Readonly<Record<string, unknown>>[];

  readonly load: (scenario: StubMenuScenario) => void;

  readonly start: (harness: StubMemoryHarness) => void;

  readonly switchMenu: () => Promise<void>;

  readonly exit: () => void;
}

export function buildStubMenuClaude(clock: Clock = systemClock): StubMenuClaude {
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

      sessions.push({ harness, open: runStubMenuSession(harness, loaded, log, clock) });
    },
    switchMenu: () => {
      const latest = readLatest();
      const second = loaded?.menus[1];

      if (second === undefined) {
        throw new Error('the scenario holds no second menu');
      }

      latest.open(second);

      // The session draws on a zero-delay timer, and timers of one delay run
      // in the order they were set.
      const drawn = Promise.withResolvers<void>();

      clock.schedule(drawn.resolve, 0);

      return drawn.promise;
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

type StubMenuEvent =
  | { readonly type: 'KEY'; readonly data: string }
  | { readonly type: 'ANSWER'; readonly data: string }
  | { readonly type: 'OPEN'; readonly menu: StubMenu };

interface MenuView {
  readonly menu: StubMenu;
  readonly cursor: number;
  readonly top: number;
  readonly checked: readonly boolean[];
}

function runStubMenuSession(
  harness: StubMemoryHarness,
  scenario: StubMenuScenario,
  log: Readonly<Record<string, unknown>>[],
  clock: Clock,
): (menu: StubMenu) => void {
  const [first] = scenario.menus;

  // xstate's clock takes a timer id, and the stand-in's clock hands back a
  // cancel.
  const cancels = new Map<number, () => void>();

  let nextTimerID = 0;

  const scheduleTimer = (run: () => void, delayMs: number) => {
    const timerID = nextTimerID++;

    cancels.set(
      timerID,
      clock.schedule(() => {
        cancels.delete(timerID);

        run();
      }, delayMs),
    );

    return timerID;
  };

  const actorClock = {
    setTimeout: scheduleTimer,
    clearTimeout: (timerID: number) => {
      cancels.get(timerID)?.();
      cancels.delete(timerID);
    },
  };

  // A terminal's output reaches its reader after the write that caused it,
  // never inside it.
  const emitLater = (screen: string) => {
    scheduleTimer(() => {
      if (harness.readExit() === null && !harness.isDetached()) {
        harness.emitData(`\u001B[2J\u001B[H${screen}`);
      }
    }, 0);
  };

  const drawView = (view: MenuView) => {
    emitLater(renderMenu(view.menu, view.cursor, view.top, view.checked));
  };

  const machine = setup({
    types: machineTypes<{ context: MenuView; events: StubMenuEvent }>(),
    guards: {
      isHeld: () => (scenario.holdMs ?? 0) > 0,
      isHeldKey: (args) => args.event.type === 'KEY' && ['\r', '\u001B'].includes(args.event.data),
      isDelayedEnter: (args) =>
        args.event.type === 'KEY' &&
        args.event.data === '\r' &&
        scenario.enterDelayMs !== undefined,
      isClosingKey: (args) =>
        args.event.type !== 'OPEN' &&
        planKey(args.context, args.event.data, scenario)?.outcome !== undefined,
    },
    delays: {
      hold: () => scenario.holdMs ?? 0,
      enterDelay: () => scenario.enterDelayMs ?? 0,
    },
    actions: {
      drawMenu: (args) => {
        drawView(args.context);
      },
      answerKey: enqueueActions((args) => {
        if (args.event.type === 'OPEN') {
          return;
        }

        const plan = planKey(args.context, args.event.data, scenario);

        if (plan === null) {
          return;
        }

        args.enqueue.assign(plan.view);

        args.enqueue(() => {
          log.push(...plan.logged);

          if (plan.outcome === undefined) {
            drawView(plan.view);
          } else {
            emitLater(`${plan.outcome}\r\n`);
          }
        });
      }),
      openMenu: enqueueActions((args) => {
        if (args.event.type !== 'OPEN') {
          return;
        }

        const view = buildMenuView(args.event.menu);

        args.enqueue.assign(view);

        args.enqueue(() => {
          drawView(view);
        });
      }),
      endHold: enqueueActions((args) => {
        const cursor = first.cursor ?? 0;
        const view = { ...args.context, cursor, top: getWindowTop(first, cursor) };

        args.enqueue.assign(view);

        args.enqueue(() => {
          drawView(view);
        });
      }),
      answerLater: raise(
        (args) => ({
          type: 'ANSWER' as const,
          data: args.event.type === 'OPEN' ? '' : args.event.data,
        }),
        { delay: 'enterDelay' },
      ),
    },
  }).createMachine({
    id: 'stub-menu',
    initial: 'starting',
    context: buildMenuView(first),
    states: {
      starting: {
        entry: 'drawMenu',
        always: [{ guard: 'isHeld', target: 'held' }, { target: 'open' }],
      },

      held: {
        after: { hold: { target: 'open', actions: 'endHold' } },
        on: {
          KEY: [{ guard: 'isHeldKey', target: 'held', reenter: true }, { actions: 'answerKey' }],
          OPEN: { actions: 'openMenu' },
        },
      },
      open: {
        on: {
          KEY: [
            { guard: 'isDelayedEnter', actions: 'answerLater' },
            { guard: 'isClosingKey', target: 'closed', actions: 'answerKey' },
            { actions: 'answerKey' },
          ],
          ANSWER: [
            { guard: 'isClosingKey', target: 'closed', actions: 'answerKey' },
            { actions: 'answerKey' },
          ],
          OPEN: { actions: 'openMenu' },
        },
      },
      closed: {
        on: { OPEN: { target: 'open', actions: 'openMenu' } },
      },
    },
  });

  const actor = createActor(machine, { clock: actorClock });

  harness.onExit(() => {
    actor.stop();

    for (const cancel of cancels.values()) {
      cancel();
    }

    cancels.clear();
  });

  harness.onInput((data) => {
    log.push({ key: KEY_NAMES[data] ?? data });
    actor.send({ type: 'KEY', data });
  });

  actor.start();

  return (menu) => {
    actor.send({ type: 'OPEN', menu });
  };
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

interface RowMarks {
  readonly above: boolean;
  readonly below: boolean;
}

function renderPointer(isCursor: boolean, more: RowMarks): string {
  if (isCursor) {
    return '❯ ';
  }

  if (more.below) {
    return '↓ ';
  }

  return more.above ? '↑ ' : '  ';
}

interface KeyPlan {
  readonly view: MenuView;
  readonly logged: readonly Readonly<Record<string, unknown>>[];
  readonly outcome?: string;
}

function planKey(view: MenuView, data: string, scenario: StubMenuScenario): KeyPlan | null {
  const menu = view.menu;
  const items = menu.options.length + (menu.submit === undefined ? 0 : 1);

  if ((data === '\u001B[A' || data === '\u001B[B') && menu.window !== undefined) {
    const moved =
      data === '\u001B[A'
        ? planWindowUp(menu, view.cursor, view.top)
        : planWindowDown(menu, view.cursor, view.top);

    return { view: { ...view, ...moved }, logged: [] };
  }

  if (data === '\u001B[A') {
    return { view: { ...view, cursor: Math.max(0, view.cursor - 1) }, logged: [] };
  }

  if (data === '\u001B[B') {
    return { view: { ...view, cursor: Math.min(items - 1, view.cursor + 1) }, logged: [] };
  }

  if (data === '\u001B') {
    return { view, logged: [{ dismissed: true }], outcome: 'Dismissed' };
  }

  if (data !== '\r') {
    return null;
  }

  return planEnter(view, scenario);
}

interface WindowState {
  readonly cursor: number;
  readonly top: number;
}

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

function planEnter(view: MenuView, scenario: StubMenuScenario): KeyPlan {
  const menu = view.menu;
  const [first, second] = scenario.menus;

  if (menu.kind === 'boxes' && view.cursor < menu.options.length) {
    const checked = view.checked.map((box, index) => (index === view.cursor ? !box : box));
    const toggled = checked[view.cursor] === true;

    return {
      view: { ...view, checked },
      logged: [{ toggled: menu.options[view.cursor] ?? '', checked: toggled }],
    };
  }

  if (menu.kind === 'boxes') {
    const enabled = menu.options.filter((_, index) => view.checked[index] === true);

    return { view, logged: [{ enabled }], outcome: `Enabled: ${enabled.join(', ')}` };
  }

  const label = menu.options[view.cursor] ?? '';

  if (scenario.pickOpensNext === true && second !== undefined && menu === first) {
    return { view: buildMenuView(second), logged: [{ picked: label }] };
  }

  return { view, logged: [{ picked: label }], outcome: `Picked: ${label}` };
}

function buildMenuView(menu: StubMenu): MenuView {
  const cursor = menu.cursor ?? 0;

  return {
    menu,
    cursor,
    top: getWindowTop(menu, cursor),
    checked: menu.options.map((_, index) => menu.checked?.[index] === true),
  };
}

function getWindowTop(menu: StubMenu, cursor: number): number {
  const size = menu.window ?? menu.options.length;

  return Math.max(0, Math.min(cursor, menu.options.length - 1) - size + 1);
}
