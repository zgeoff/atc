import type { MenuTerminal, MenuWaits } from './menu-terminal';
import { waitForMenuPoll } from './wait-for-menu-poll';

/**
 * Waits until the agent has printed nothing for the quiet time, or gives up
 * waiting once the cap passes, for a screen that never stops changing.
 * Claude Code ignores Enter and Escape for a hold after a dialog opens, and
 * resets the dialog's cursor when the hold ends, so the quiet time outlasts
 * that hold.
 */
export async function waitForMenuQuiet(terminal: MenuTerminal, waits: MenuWaits): Promise<void> {
  const deadline = waits.clock.now() + waits.timing.quietCapMs;

  while (
    waits.clock.now() < deadline &&
    waits.clock.now() - terminal.readLastOutputAt() < waits.timing.quietMs
  ) {
    await waitForMenuPoll(waits);
  }
}
