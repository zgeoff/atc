import type { MenuTerminal, MenuWaits } from './menu-terminal';
import { waitForMenuPoll } from './wait-for-menu-poll';

// Claude Code ignores Enter and Escape for a hold after a dialog opens and
// resets the dialog's cursor when the hold ends, so the quiet time outlasts
// that hold; the cap covers a screen that never stops changing
export async function waitForMenuQuiet(terminal: MenuTerminal, waits: MenuWaits): Promise<void> {
  const deadline = waits.clock.now() + waits.timing.quietCapMs;

  while (
    waits.clock.now() < deadline &&
    waits.clock.now() - terminal.readLastOutputAt() < waits.timing.quietMs
  ) {
    await waitForMenuPoll(waits);
  }
}
