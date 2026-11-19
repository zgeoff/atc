import type { Clock } from '@atc/core';
import type { ScreenMenu } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { MenuView } from '@atcx/contract';
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

export async function applyMenuChoice(
  terminal: MenuTerminal,
  choice: MenuChoice,
  clock: Clock,
  timing: MenuTiming = MENU_TIMING,
): Promise<MenuChoiceResult> {
  const waits = { clock, timing };

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

  // An agent can move the cursor back after the last read, such as when it ends a dialog's hold.
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

  const settled = await waitForSettledMenu(terminal, last.screen, waits);

  return { pressed: 'enter', ...(await readSettledWholeMenu(terminal, settled, waits)) };
}

async function readWholeMenuView(
  terminal: MenuTerminal,
  waits: MenuWaits,
): Promise<MenuView | null> {
  const menu = await readWholeMenu(terminal, waits);

  return menu === null ? null : buildMenuView(menu);
}

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

function buildViewOrNull(menu: ScreenMenu | null): MenuView | null {
  return menu === null ? null : buildMenuView(menu);
}

// Enter or Escape can open another list with the same text and rows in view as the kept menu,
// so the kept menu must be dropped before the key goes through.
function sendKeyFromScreen(terminal: MenuTerminal, key: string): void {
  terminal.recordWholeMenu(null);

  sendMenuKey(terminal, key);
}

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

async function readMenuView(terminal: MenuTerminal): Promise<MenuView | null> {
  const menu = await readKnownMenu(terminal);

  return menu === null ? null : buildMenuView(menu);
}

function isSameMenu(left: MenuView | null, right: MenuView | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return left.menuToken === right.menuToken && getHighlighted(left) === getHighlighted(right);
}

function getHighlighted(menu: MenuView): number {
  return menu.options.find((option) => option.highlighted)?.option ?? 0;
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
    const whole = await readWholeMenuView(terminal, waits);

    return { menu: whole };
  } catch (error) {
    if (error instanceof DaemonError) {
      // The failed read may have moved the cursor with its arrow keys, so the screen is read again.
      return { menu: await readMenuView(terminal), partial: true };
    }

    throw error;
  }
}

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
