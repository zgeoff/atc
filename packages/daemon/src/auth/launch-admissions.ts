import type { SessionID } from '@atc/core';
import type { LaunchTicket } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';

export class LaunchAdmissions {
  // The admissions on each host whose request has not gone out yet. A
  // revoke, a rebind or a forget cancels them before it writes anything,
  // so a request still opening its connection closes it unsent.
  private readonly pending = new Map<SessionID, Set<{ refusal: DaemonError | null }>>();

  // Records an admission on a host and returns the ticket its request
  // checks just before it goes out.
  createTicket(hostKey: SessionID): LaunchTicket {
    const ticket: { refusal: DaemonError | null } = { refusal: null };
    const tickets = this.pending.get(hostKey) ?? new Set();

    tickets.add(ticket);
    this.pending.set(hostKey, tickets);

    const release = () => {
      tickets.delete(ticket);

      if (tickets.size === 0 && this.pending.get(hostKey) === tickets) {
        this.pending.delete(hostKey);
      }
    };

    return {
      check: () => {
        release();

        return ticket.refusal;
      },
      release,
    };
  }

  // How many admitted requests on a host have not gone out or ended yet.
  countPendingAdmissions(hostKey: SessionID): number {
    return this.pending.get(hostKey)?.size ?? 0;
  }

  // Stops every admitted request on a host that has not gone out yet,
  // with the block the caller is about to record.
  revokeAdmissions(hostKey: SessionID, state: string): void {
    const tickets = this.pending.get(hostKey);

    this.pending.delete(hostKey);

    for (const ticket of tickets ?? []) {
      ticket.refusal = new DaemonError(
        'auth_blocked',
        `the runtime auth of host ${hostKey} is ${state}; nothing launches on it until a rebind`,
        { host: hostKey, state },
      );
    }
  }
}
