import type { LaunchTicket } from '@atc/plugin-api';
import type { AtcError } from '@atcx/contract/light';

export function buildStubLaunchAdmission(check: () => AtcError | null) {
  return {
    admit: (_kind: 'start' | 'attach', send: (ticket: LaunchTicket) => void): Promise<void> => {
      // Send the ticket before the promise settles: the real admission sends it
      // while it still holds the host lock, and this stub keeps that order.
      send({ check, release: () => {} });

      return Promise.resolve();
    },
  };
}
