import type { Clock } from '@atc/core';
import type { ScreenMenu } from '@atc/plugin-api';
import type { MenuView } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import { buildMenuView } from './build-menu-view';
import { expandScreenMenu } from './expand-screen-menu';
import { MENU_KEYS, MENU_TIMING } from './menu-terminal';
import type { MenuTerminal, MenuTiming, MenuWaits } from './menu-terminal';
import { readKnownMenu } from './read-known-menu';
import { readWholeMenu } from './read-whole-menu';
import { sendMenuKey } from './send-menu-key';
import { waitForMenuPoll } from './wait-for-menu-poll';
import { waitForMenuQuiet } from './wait-for-menu-quiet';

export type MenuChoice =
  | { readonly menuToken: string; readonly option: number; readonly label: string }
  | { readonly menuToken: string; readonly key: 'escape' };

export interface MenuChoiceResult {
  readonly pressed: 'enter' | 'escape';
  readonly menu: MenuView | null;
  readonly partial?: true;
}

// throws before Enter when the menu changed, the label differs, or the cursor never reaches the
// option, so nothing is picked; options are numbered by their place in the whole scrolled list
export async function applyMenuChoice(
  terminal: MenuTerminal,
  choice: MenuChoice,
  clock: Clock,
  timing: MenuTiming = MENU_TIMING,
): Promise<MenuChoiceResult> {
  const waits = { clock, timing };

  // A choice that does not match fails at once; one that matches is checked
  // again once the screen is quiet, since the menu can change meanwhile.
  const first = await readWholeMenuView(terminal, waits);

  requireMatchingMenu(first, choice);

  // a menu that has just opened takes keys and keeps its cursor only once the agent stops printing
  await waitForMenuQuiet(terminal, waits);

  const quiet = await readCheckedMenu(terminal, choice);

  const menu = quiet.menu;

  if ('key' in choice) {
    sendKeyFromScreen(terminal, MENU_KEYS.escape);

    const dismissed = await waitForSettledMenu(terminal, quiet.screen, waits);

    return { pressed: 'escape', ...(await readSettledWholeMenu(terminal, dismissed, waits)) };
  }

  await runCursorWalk(terminal, menu, choice.option, waits);

  // The cursor can move back between the walk's last read and Enter, such
  // as when an agent ends a dialog's hold, so the screen is read once more.
  const last = await readCheckedMenu(terminal, choice);

  const committed = last.menu;

  if (getHighlighted(committed) !== choice.option) {
    throw new DaemonError(
      'menu_busy',
      `the cursor left option ${choice.option} before Enter, so nothing was picked; choose again`,
      { menu: committed },
    );
  }

  sendKeyFromScreen(terminal, MENU_KEYS.enter);

  // The settled menu is measured against the screen just before Enter, so a
  // cursor move from the walk never counts as Enter's response.
  const settled = await waitForSettledMenu(terminal, last.screen, waits);

  return { pressed: 'enter', ...(await readSettledWholeMenu(terminal, settled, waits)) };
}

async function readSettledWholeMenu(
  terminal: MenuTerminal,
  settled: MenuView | null,
  waits: MenuWaits,
): Promise<{ readonly menu: MenuView | null; readonly partial?: true }> {
  if (settled === null) {
    return { menu: null };
  }

  try {
    // the whole list, so a list longer than the screen returns the token the next choice carries
    const whole = await readWholeMenuView(terminal, waits);

    return { menu: whole };
  } catch (error) {
    if (error instanceof DaemonError) {
      // the key has gone through, so this answers rather than refuses; the failed read may have
      // moved the cursor with its arrow keys, so the screen is read again
      return { menu: await readMenuView(terminal), partial: true };
    }

    throw error;
  }
}

// The whole menu as a client reads it, scrolling a list that has not been
// read whole before.
async function readWholeMenuView(
  terminal: MenuTerminal,
  waits: MenuWaits,
): Promise<MenuView | null> {
  const menu = await readWholeMenu(terminal, waits);

  return menu === null ? null : buildMenuView(menu);
}

// The menu the screen shows, through the whole menu atc last read when the
// screen shows part of it, as a client reads it. It presses no key, so it
// can poll the screen while the cursor moves.
async function readMenuView(terminal: MenuTerminal): Promise<MenuView | null> {
  const menu = await readKnownMenu(terminal);

  return menu === null ? null : buildMenuView(menu);
}

// one screen read gives both the checked menu and the baseline the next key's response is
// measured against, so the key reaches the screen the check passed
async function readCheckedMenu(
  terminal: MenuTerminal,
  choice: MenuChoice,
): Promise<{ readonly menu: MenuView; readonly screen: MenuView }> {
  const shown = await terminal.readScreenMenu();

  const known = terminal.findWholeMenu();
  const whole = shown === null || known === null ? null : expandScreenMenu(shown, known);

  terminal.recordWholeMenu(whole);

  const menu = requireMatchingMenu(buildViewOrNull(whole ?? shown), choice);

  return { menu, screen: shown === null ? menu : buildMenuView(shown) };
}

// Presses Enter or Escape. Either key can open another list with the same
// text and the same rows in view as the kept whole menu, so the kept menu
// is dropped first and the menu the key leaves is read afresh.
function sendKeyFromScreen(terminal: MenuTerminal, key: string): void {
  terminal.recordWholeMenu(null);

  sendMenuKey(terminal, key);
}

function buildViewOrNull(menu: ScreenMenu | null): MenuView | null {
  return menu === null ? null : buildMenuView(menu);
}

// The menu the screen shows, when its token is the choice's and, for an
// option, that option's label is the one the choice expects.
function requireMatchingMenu(menu: MenuView | null, choice: MenuChoice): MenuView {
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

    const key = at < option ? MENU_KEYS.down : MENU_KEYS.up;

    sendMenuKey(terminal, key);

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
    await waitForMenuPoll(waits);

    const now = await readMenuView(terminal);

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

  let last = await readMenuView(terminal);

  let lastChangeAt = isSameMenu(last, before) ? null : clock.now();

  while (clock.now() < deadline) {
    if (lastChangeAt !== null && clock.now() - lastChangeAt >= waits.timing.stableMs) {
      return last;
    }

    await waitForMenuPoll(waits);

    const now = await readMenuView(terminal);

    if (!isSameMenu(now, last)) {
      last = now;
      lastChangeAt = clock.now();
    }
  }

  return last;
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
