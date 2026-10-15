import type { ScreenMenu, ScreenMenuOption } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import { expandScreenMenu } from './expand-screen-menu';
import { MENU_KEYS } from './menu-terminal';
import type { MenuTerminal, MenuWaits } from './menu-terminal';
import { readKnownMenu } from './read-known-menu';
import { sendMenuKey } from './send-menu-key';
import { splitScreenMenu } from './split-screen-menu';
import { waitForMenuPoll } from './wait-for-menu-poll';
import { waitForMenuQuiet } from './wait-for-menu-quiet';

// The most arrow keys one read presses, so a list that never ends, or a
// screen that keeps changing, stops the read instead of holding the
// session's input.
const MAX_STEPS = 400;

/**
 * Reads the whole menu the session's screen shows, or null when it shows
 * none. A menu that fits on the screen, or one the whole menu atc read
 * before holds, takes no key. A list that scrolls past the screen is read
 * with the arrow keys: atc waits for the agent to go quiet, moves the
 * cursor up to the first option, then down one option at a time until the
 * list ends, and moves it back to the option it started on. It presses
 * neither Enter nor Escape, and keeps the whole menu for the next read.
 * A session with no live process reads as its screen shows it.
 */
export async function readWholeMenu(
  terminal: MenuTerminal,
  waits: MenuWaits,
): Promise<ScreenMenu | null> {
  const shown = await readKnownMenu(terminal);

  if (shown?.scroll === undefined || !terminal.isLive()) {
    return shown;
  }

  await waitForMenuQuiet(terminal, waits);

  const start = await readKnownMenu(terminal);

  if (start?.scroll === undefined) {
    return start;
  }

  const whole = await collectScrolledMenu(terminal, start, waits);

  terminal.recordWholeMenu(whole);

  return whole;
}

// The arrow keys one read has pressed so far.
interface StepCount {
  count: number;
}

// Moves the cursor up to the first option, down to the end of the list,
// and back to where it started, gathering the list's rows on the way down.
async function collectScrolledMenu(
  terminal: MenuTerminal,
  start: ScreenMenu,
  waits: MenuWaits,
): Promise<ScreenMenu> {
  const steps: StepCount = { count: 0 };
  const startList = splitScreenMenu(start).list.length;
  let now = start;
  let ups = 0;

  while (now.highlighted !== 0 || now.scroll?.above === true) {
    now = await sendArrow(terminal, now, MENU_KEYS.up, steps, waits);

    ups++;
  }

  const list: ScreenMenuOption[] = [...splitScreenMenu(now).list];
  let at = 0;

  for (;;) {
    const rows = splitScreenMenu(now).list.length;

    // The cursor's own row hides the list's mark, so without a mark below
    // the window shows the list's end only when the cursor sits above it.
    if (now.scroll?.below !== true && now.highlighted !== rows - 1) {
      break;
    }

    now = await sendArrow(terminal, now, MENU_KEYS.down, steps, waits);

    const moved = splitScreenMenu(now).list;

    // A cursor that leaves the list for an item after it, or lands on the
    // first row again, has passed the list's last option.
    if (now.highlighted >= moved.length) {
      at = list.length + now.highlighted - moved.length;
      break;
    }

    if (now.highlighted === 0) {
      at = 0;
      break;
    }

    at++;

    const offset = at - now.highlighted;

    for (const [index, option] of moved.entries()) {
      list[offset + index] = option;
    }
  }

  const after = splitScreenMenu(now).after;

  // A walk that starts on an item after the list goes up into the list
  // first, so its count of up keys includes that step.
  const target = start.highlighted < startList ? ups : list.length + start.highlighted - startList;

  while (at !== target) {
    const key = at < target ? MENU_KEYS.down : MENU_KEYS.up;

    now = await sendArrow(terminal, now, key, steps, waits);

    at += at < target ? 1 : -1;
  }

  const whole = expandScreenMenu(now, {
    text: start.text,
    options: [...list, ...after],
    highlighted: target,
  });

  if (whole === null) {
    throw new DaemonError('menu_changed', 'the menu changed while atc read its whole list', {
      menu: null,
    });
  }

  return whole;
}

// Presses one arrow key and waits for the screen to show the cursor or the
// list's rows move. A read with another menu, or none, stops the walk.
async function sendArrow(
  terminal: MenuTerminal,
  before: ScreenMenu,
  key: string,
  steps: StepCount,
  waits: MenuWaits,
): Promise<ScreenMenu> {
  steps.count++;

  if (steps.count > MAX_STEPS) {
    throw new DaemonError('menu_busy', 'atc could not find the end of the menu list', {
      menu: null,
    });
  }

  sendMenuKey(terminal, key);

  const deadline = waits.clock.now() + waits.timing.moveMs;

  while (waits.clock.now() < deadline) {
    await waitForMenuPoll(waits);

    const now = await terminal.readScreenMenu();

    if (now === null || now.text !== before.text) {
      throw new DaemonError('menu_changed', 'the menu changed while atc read its whole list', {
        menu: null,
      });
    }

    if (hasMoved(before, now)) {
      return now;
    }
  }

  throw new DaemonError(
    'menu_busy',
    'the menu ignored the arrow key while atc read its whole list; wait a few seconds and read it again',
    { menu: null },
  );
}

function hasMoved(before: ScreenMenu, now: ScreenMenu): boolean {
  return (
    before.highlighted !== now.highlighted ||
    before.options.length !== now.options.length ||
    before.options.some((option, index) => option.label !== now.options[index]?.label)
  );
}
