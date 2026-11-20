import type { LaunchTicket } from '@atc/plugin-api';
import type { SessionID } from '@atcx/contract';
import { AtcError } from '@atcx/contract/light';

export interface LaunchAdmissions {
  readonly createTicket: (hostKey: SessionID) => LaunchTicket;

  readonly countPendingAdmissions: (hostKey: SessionID) => number;

  readonly revokeAdmissions: (hostKey: SessionID, state: string) => void;
}

export function createLaunchAdmissions(): LaunchAdmissions {
  const pending = new Map<SessionID, Set<{ refusal: AtcError | null }>>();

  return {
    createTicket: (hostKey) => {
      const ticket: { refusal: AtcError | null } = { refusal: null };
      const tickets = pending.get(hostKey) ?? new Set();

      tickets.add(ticket);
      pending.set(hostKey, tickets);

      const release = () => {
        tickets.delete(ticket);

        if (tickets.size === 0 && pending.get(hostKey) === tickets) {
          pending.delete(hostKey);
        }
      };

      return {
        check: () => {
          release();

          return ticket.refusal;
        },
        release,
      };
    },

    countPendingAdmissions: (hostKey) => pending.get(hostKey)?.size ?? 0,

    revokeAdmissions: (hostKey, state) => {
      const tickets = pending.get(hostKey);

      pending.delete(hostKey);

      for (const ticket of tickets ?? []) {
        ticket.refusal = new AtcError(
          'auth_blocked',
          `the runtime auth of host ${hostKey} is ${state}; nothing launches on it until a rebind`,
          { host: hostKey, state },
        );
      }
    },
  };
}
