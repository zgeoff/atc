import type { MenuWaits } from './menu-terminal';

/**
 * Resolves once one poll interval of the menu timing passes on its clock.
 */
export function waitForMenuPoll(waits: MenuWaits): Promise<void> {
  return new Promise((resolve) => {
    waits.clock.schedule(resolve, waits.timing.pollMs);
  });
}
