import { mintApprovalCode } from './mint-approval-code';
import { normalizeApprovalCode } from './normalize-approval-code';

interface ApprovalRequest {
  // The signed authorization query the login page carries: one per request.
  readonly key: string;
  readonly clientID: string;
  readonly clientName: string;
  readonly redirectURI: string;
}

/**
 * An authorization request waiting for the operator to type its approval code.
 */
export interface PendingApproval extends ApprovalRequest {
  readonly approvalCode: string;
  attempts: number;
  readonly expiresAt: number;
}

// At most this many approvals wait at once across every client, and each
// client holds at most this many. Across every client, at most this many
// approvals start per minute, which bounds how fast approval lines print.
const MAX_PENDING = 16;
const MAX_PENDING_PER_CLIENT = 3;
const MAX_STARTS_PER_MINUTE = 10;
const MAX_ATTEMPTS = 5;
const MINUTE_MS = 60_000;

/**
 * The approvals waiting for the operator, held in memory by the HTTP process.
 * A client's new approval past its limit drops that client's oldest, and a
 * full set of waiting approvals makes room by dropping the oldest overall, so
 * no client can hold the operator's approvals hostage and a refused start
 * lasts at most a minute.
 */
export class ApprovalState {
  private readonly pendingMs: number;

  private readonly now: () => number;

  private readonly pending = new Map<string, PendingApproval>();

  // Approval start times within the last minute, oldest first.
  private startedAt: readonly number[] = [];

  constructor(pendingMs: number, now: () => number) {
    this.pendingMs = pendingMs;
    this.now = now;
  }

  // Returns null when the last minute already holds its share of starts.
  createPending(request: ApprovalRequest): PendingApproval | null {
    const now = this.now();

    this.removeExpired(now);

    this.startedAt = this.startedAt.filter((at) => now - at < MINUTE_MS);

    if (this.startedAt.length >= MAX_STARTS_PER_MINUTE) {
      return null;
    }

    const own = [...this.pending].filter(([, approval]) => approval.clientID === request.clientID);
    const [ownOldest] = own;

    if (own.length >= MAX_PENDING_PER_CLIENT && ownOldest !== undefined) {
      this.pending.delete(ownOldest[0]);
    }

    const oldest = this.pending.keys().next();

    if (this.pending.size >= MAX_PENDING && oldest.done !== true) {
      this.pending.delete(oldest.value);
    }

    const approval: PendingApproval = {
      ...request,
      approvalCode: mintApprovalCode(),
      attempts: 0,
      expiresAt: now + this.pendingMs,
    };

    this.pending.set(approval.key, approval);

    this.startedAt = [...this.startedAt, now];

    return approval;
  }

  findPending(key: string): PendingApproval | null {
    this.removeExpired(this.now());

    return this.pending.get(key) ?? null;
  }

  // A wrong code counts against the approval; the last allowed miss drops it.
  verifyApprovalCode(key: string, typed: string): 'ok' | 'wrong' | 'locked' {
    const approval = this.findPending(key);

    if (approval === null) {
      return 'locked';
    }

    if (normalizeApprovalCode(typed) === approval.approvalCode) {
      this.pending.delete(key);

      return 'ok';
    }

    approval.attempts += 1;

    if (approval.attempts >= MAX_ATTEMPTS) {
      this.pending.delete(key);

      return 'locked';
    }

    return 'wrong';
  }

  private removeExpired(now: number): void {
    for (const [key, approval] of this.pending) {
      if (approval.expiresAt <= now) {
        this.pending.delete(key);
      }
    }
  }
}
