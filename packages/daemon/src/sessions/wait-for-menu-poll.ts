import type { MenuWaits } from './menu-terminal';

export function waitForMenuPoll(waits: MenuWaits): Promise<void> {
  return new Promise((resolve) => {
    waits.clock.schedule(resolve, waits.timing.pollMs);
  });
}
