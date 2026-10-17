import type { LaunchTicket } from '@atc/plugin-api';
import type { DaemonError } from '@atc/protocol/wire';

export function buildStubLaunchAdmission(check: () => DaemonError | null) {
  return {
    admit: (_kind: 'start' | 'attach', send: (ticket: LaunchTicket) => void): Promise<void> => {
      // The ticket goes out before the admission settles, as the binder sends it
      // under its host lock.
      send({ check, release: () => {} });

      return Promise.resolve();
    },
  };
}
