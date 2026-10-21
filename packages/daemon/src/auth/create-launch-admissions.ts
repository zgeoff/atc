import type { SessionID } from '@atc/core';
import type { LaunchTicket } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';

export interface LaunchAdmissions {
  // Records an admission on a host and returns the ticket its request
  // checks just before it goes out.
  readonly createTicket: (hostKey: SessionID) => LaunchTicket;

  // How many admitted requests on a host have not gone out or ended yet.
  readonly countPendingAdmissions: (hostKey: SessionID) => number;

  // Stops every admitted request on a host that has not gone out yet,
  // with the block the caller is about to record.
  readonly revokeAdmissions: (hostKey: SessionID, state: string) => void;
}

export function createLaunchAdmissions(): LaunchAdmissions {
  // The admissions on each host whose request has not gone out yet. A
  // revoke, a rebind or a forget cancels them before it writes anything,
  // so a request still opening its connection closes it unsent.
  const pending = new Map<SessionID, Set<{ refusal: DaemonError | null }>>();

  return {
    createTicket: (hostKey) => {
      const ticket: { refusal: DaemonError | null } = { refusal: null };
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
        ticket.refusal = new DaemonError(
          'auth_blocked',
          `the runtime auth of host ${hostKey} is ${state}; nothing launches on it until a rebind`,
          { host: hostKey, state },
        );
      }
    },
  };
}
