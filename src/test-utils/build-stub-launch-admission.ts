import type { LaunchTicket } from '../daemon/execution-provider';
import type { DaemonError } from '../protocol/daemon-error';

/**
 * A runtime auth binder's launch admission for a harness behind the
 * broker. `admit` admits every start and attach: it hands `send` a ticket
 * at once, before the admission settles, as the binder does under its host
 * lock, and then resolves. The ticket's check runs the given check, which
 * returns the refusal that stops the request unsent or null to let it go,
 * and may throw as a broken binder would. Its release does nothing.
 */
export function buildStubLaunchAdmission(check: () => DaemonError | null) {
  return {
    admit: (_kind: 'start' | 'attach', send: (ticket: LaunchTicket) => void): Promise<void> => {
      send({ check, release: () => {} });

      return Promise.resolve();
    },
  };
}
