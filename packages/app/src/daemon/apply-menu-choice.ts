import type { Clock } from '@atc/core/system-clock';
import { DaemonError } from '@atc/protocol/daemon-error';
import type { MenuView } from '@atc/protocol/menu-view';

const KEYS = {
  up: '\u001B[A',
  down: '\u001B[B',
  enter: '\r',
  escape: '\u001B',
} as const;

/**
 * The session's terminal as a choice drives it: a fresh read of the menu
 * its screen shows, when its agent last printed anything, a write to its
 * PTY, and whether that PTY still runs.
 */
export interface MenuTerminal {
  readonly readMenu: () => Promise<MenuView | null>;
  readonly readLastOutputAt: () => number;
  readonly write: (data: string) => void;
  readonly isLive: () => boolean;
}

/**
 * The menu a choice answers, through its token, and either the option it
 * picks with the label it expects there, or the Escape key.
 */
export type MenuChoice =
  | { readonly menuToken: string; readonly option: number; readonly label: string }
  | { readonly menuToken: string; readonly key: 'escape' };

/**
 * How long a choice waits on the screen. Before its first key it waits for
 * the agent to print nothing for `quietMs`, at most `quietCapMs` in all. An
 * arrow key gets `moveMs` to move the cursor. After the last key, the
 * screen counts as settled once it stays the same for `stableMs`, or once
 * `settleMs` passes.
 */
export interface MenuTiming {
  readonly pollMs: number;
  readonly quietMs: number;
  readonly quietCapMs: number;
  readonly moveMs: number;
  readonly settleMs: number;
  readonly stableMs: number;
}

export interface MenuChoiceResult {
  readonly pressed: 'enter' | 'escape';
  readonly menu: MenuView | null;
}

// The clock a choice reads the time from and waits on, and how long it waits.
interface MenuWaits {
  readonly clock: Clock;
  readonly timing: MenuTiming;
}

// Claude Code refuses Enter and Escape for a hold after a dialog opens, and
// resets the dialog's cursor to its default option when the hold ends, so
// the quiet wait outlasts that hold.
const MENU_TIMING: MenuTiming = {
  pollMs: 50,
  quietMs: 4000,
  quietCapMs: 10_000,
  moveMs: 1500,
  settleMs: 4000,
  stableMs: 300,
};

/**
 * Picks one option of the menu the session's screen shows, or presses
 * Escape on it. It first waits for the agent to stop printing, so a menu
 * that has just opened takes keys and keeps its cursor. It then checks the
 * menu's token and the option's label against the screen before it writes
 * anything, moves the cursor one arrow key at a time and reads the screen
 * after each, and presses Enter only once the cursor sits on the option. A
 * changed menu, a wrong label, or a cursor that never reaches the option
 * throws before Enter, so nothing is picked. Resolves with the key it
 * pressed last and the menu the screen shows once it settles, or null when
 * it shows none.
 */
export async function applyMenuChoice(
  terminal: MenuTerminal,
  choice: MenuChoice,
  clock: Clock,
  timing: MenuTiming = MENU_TIMING,
): Promise<MenuChoiceResult> {
  const waits = { clock, timing };

  // A choice that does not match fails at once; one that matches is checked
  // again once the screen is quiet, since the menu can change meanwhile.
  await requireMatchingMenu(terminal, choice);
  await waitForQuiet(terminal, waits);

  const menu = await requireMatchingMenu(terminal, choice);

  if ('key' in choice) {
    sendKey(terminal, KEYS.escape);

    return { pressed: 'escape', menu: await waitForSettledMenu(terminal, menu, waits) };
  }

  await runCursorWalk(terminal, menu, choice.option, waits);

  // The cursor can move back between the walk's last read and Enter, such
  // as when an agent ends a dialog's hold, so the screen is read once more.
  const committed = await requireMatchingMenu(terminal, choice);

  if (getHighlighted(committed) !== choice.option) {
    throw new DaemonError(
      'menu_busy',
      `the cursor left option ${choice.option} before Enter, so nothing was picked; choose again`,
      { menu: committed },
    );
  }

  sendKey(terminal, KEYS.enter);

  return { pressed: 'enter', menu: await waitForSettledMenu(terminal, menu, waits) };
}

// A session that exits keeps its last screen, so a menu read can still
// match after its agent is gone; each key checks the PTY first.
function sendKey(terminal: MenuTerminal, key: string): void {
  if (!terminal.isLive()) {
    throw new DaemonError('session_dead', 'the session has no live process, so nothing was picked');
  }

  terminal.write(key);
}

// The menu the screen shows, when its token is the choice's and, for an
// option, that option's label is the one the choice expects.
async function requireMatchingMenu(terminal: MenuTerminal, choice: MenuChoice): Promise<MenuView> {
  const menu = await terminal.readMenu();

  if (menu === null) {
    throw new DaemonError('menu_changed', 'the session shows no menu now', { menu: null });
  }

  if (menu.menuToken !== choice.menuToken) {
    throw new DaemonError(
      'menu_changed',
      `the session shows another menu now, with menuToken '${menu.menuToken}'`,
      { menu },
    );
  }

  if ('key' in choice) {
    return menu;
  }

  const target = menu.options.find((option) => option.option === choice.option);

  if (target === undefined || target.label !== choice.label) {
    const reason =
      target === undefined
        ? `the menu has no option ${choice.option}`
        : `option ${choice.option} of the menu is '${target.label}', not '${choice.label}'`;

    throw new DaemonError('menu_label_mismatch', reason, { menu });
  }

  return menu;
}

// Waits until the agent has printed nothing for the quiet time, or gives up
// waiting once the cap passes, for a screen that never stops changing.
async function waitForQuiet(terminal: MenuTerminal, waits: MenuWaits): Promise<void> {
  const deadline = waits.clock.now() + waits.timing.quietCapMs;

  while (
    waits.clock.now() < deadline &&
    waits.clock.now() - terminal.readLastOutputAt() < waits.timing.quietMs
  ) {
    await waitForPoll(waits);
  }
}

// Each step presses the arrow toward the option and waits for the cursor to
// move; the screen decides the next step, so a slow move never sends the
// cursor past the option.
async function runCursorWalk(
  terminal: MenuTerminal,
  menu: MenuView,
  option: number,
  waits: MenuWaits,
): Promise<void> {
  let at = getHighlighted(menu);

  for (let steps = 0; at !== option; steps++) {
    if (steps > menu.options.length * 2) {
      throw new DaemonError('menu_busy', `the cursor did not reach option ${option}`, { menu });
    }

    const key = at < option ? KEYS.down : KEYS.up;

    sendKey(terminal, key);

    const moved = await waitForMove(terminal, menu, at, waits);

    if (moved === null) {
      throw new DaemonError(
        'menu_busy',
        'the menu ignored the arrow key, so nothing was picked; wait a few seconds and choose again',
        { menu },
      );
    }

    at = moved;
  }
}

// The option the cursor moved to, or null when it stays put for `moveMs`.
async function waitForMove(
  terminal: MenuTerminal,
  menu: MenuView,
  at: number,
  waits: MenuWaits,
): Promise<number | null> {
  const deadline = waits.clock.now() + waits.timing.moveMs;

  while (waits.clock.now() < deadline) {
    await waitForPoll(waits);

    const now = await terminal.readMenu();

    if (now === null || now.menuToken !== menu.menuToken) {
      throw new DaemonError('menu_changed', 'the menu changed while the cursor moved', {
        menu: now,
      });
    }

    const highlighted = getHighlighted(now);

    if (highlighted !== at) {
      return highlighted;
    }
  }

  return null;
}

// The menu once the screen stops changing after the key: a new one, the
// same one with a ticked box, or none. A screen that never changes settles
// as it stands once `settleMs` passes.
async function waitForSettledMenu(
  terminal: MenuTerminal,
  before: MenuView,
  waits: MenuWaits,
): Promise<MenuView | null> {
  const clock = waits.clock;
  const deadline = clock.now() + waits.timing.settleMs;

  let last = await terminal.readMenu();

  let lastChangeAt = isSameMenu(last, before) ? null : clock.now();

  while (clock.now() < deadline) {
    if (lastChangeAt !== null && clock.now() - lastChangeAt >= waits.timing.stableMs) {
      return last;
    }

    await waitForPoll(waits);

    const now = await terminal.readMenu();

    if (!isSameMenu(now, last)) {
      last = now;
      lastChangeAt = clock.now();
    }
  }

  return last;
}

function waitForPoll(waits: MenuWaits): Promise<void> {
  return new Promise((resolve) => {
    waits.clock.schedule(resolve, waits.timing.pollMs);
  });
}

function isSameMenu(a: MenuView | null, b: MenuView | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }

  return a.menuToken === b.menuToken && getHighlighted(a) === getHighlighted(b);
}

function getHighlighted(menu: MenuView): number {
  return menu.options.find((option) => option.highlighted)?.option ?? 0;
}
