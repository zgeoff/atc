import { randomBytes } from 'node:crypto';

interface ApprovalRequest {
  // The signed authorization query the login page carries: one per request.
  readonly key: string;
  readonly clientID: string;
  readonly clientName: string;
  readonly redirectURI: string;
}

export interface PendingApproval extends ApprovalRequest {
  // Random, minted with the approval and never taken from the request, so
  // the security events of one authorization can be matched up.
  readonly correlationID: string;
  failures: number;
  readonly expiresAt: number;

  // The one WebAuthn challenge this request's login page holds, if any.
  challenge: { readonly value: string; readonly expiresAt: number } | null;
}

export type TakenChallenge =
  | { readonly kind: 'taken'; readonly challenge: string }
  | { readonly kind: 'expired' }
  | { readonly kind: 'missing' };

// At most this many approvals wait at once across every client, and each
// client holds at most this many. Across every client, at most this many
// approvals start per minute.
const MAX_PENDING = 16;
const MAX_PENDING_PER_CLIENT = 3;
const MAX_STARTS_PER_MINUTE = 10;
const MAX_FAILURES = 5;
const MINUTE_MS = 60_000;

// How long a login page's challenge stays valid, unless its request
// expires sooner.
const CHALLENGE_MS = 5 * MINUTE_MS;

export interface ApprovedRequest {
  readonly binding: string;
  readonly correlationID: string;
  readonly expiresAt: number;
}

export class ApprovalState {
  private readonly pendingMs: number;

  private readonly now: () => number;

  private readonly pending = new Map<string, PendingApproval>();

  // Owner session id to the binding of the request its sign-in approved.
  private readonly approved = new Map<string, ApprovedRequest>();

  // Approval start times within the last minute, oldest first.
  private startedAt: readonly number[] = [];

  constructor(pendingMs: number, now: () => number) {
    this.pendingMs = pendingMs;
    this.now = now;
  }

  // Returns null when the last minute already holds its share of starts.
  createPending(request: ApprovalRequest): PendingApproval | null {
    const now = this.now();

    this.dropExpired(now);

    this.startedAt = this.startedAt.filter((at) => now - at < MINUTE_MS);

    if (this.startedAt.length >= MAX_STARTS_PER_MINUTE) {
      return null;
    }

    const own = [...this.pending].filter(([, approval]) => approval.clientID === request.clientID);
    const [ownOldest] = own;

    // a new approval drops the oldest rather than being refused, so no client can
    // hold the owner's approvals hostage.
    if (own.length >= MAX_PENDING_PER_CLIENT && ownOldest !== undefined) {
      this.pending.delete(ownOldest[0]);
    }

    const oldest = this.pending.keys().next();

    if (this.pending.size >= MAX_PENDING && oldest.done !== true) {
      this.pending.delete(oldest.value);
    }

    const approval: PendingApproval = {
      ...request,
      correlationID: crypto.randomUUID(),
      failures: 0,
      expiresAt: now + this.pendingMs,
      challenge: null,
    };

    this.pending.set(approval.key, approval);

    this.startedAt = [...this.startedAt, now];

    return approval;
  }

  findPending(key: string): PendingApproval | null {
    this.dropExpired(this.now());

    return this.pending.get(key) ?? null;
  }

  // A fresh random challenge for the request's login page, replacing any
  // earlier one, or null when the request no longer waits.
  mintChallenge(key: string): string | null {
    const approval = this.findPending(key);

    if (approval === null) {
      return null;
    }

    const value = randomBytes(32).toString('base64url');

    approval.challenge = {
      value,
      expiresAt: Math.min(this.now() + CHALLENGE_MS, approval.expiresAt),
    };

    return value;
  }

  // Takes the request's challenge, so it verifies at most one assertion.
  claimChallenge(key: string): TakenChallenge {
    const approval = this.findPending(key);
    const challenge = approval?.challenge ?? null;

    if (approval === null || challenge === null) {
      return { kind: 'missing' };
    }

    approval.challenge = null;

    if (challenge.expiresAt <= this.now()) {
      return { kind: 'expired' };
    }

    return { kind: 'taken', challenge: challenge.value };
  }

  // A failed sign-in counts against the request; the last allowed failure
  // drops it.
  recordFailure(key: string): 'retry' | 'locked' {
    const approval = this.findPending(key);

    if (approval === null) {
      return 'locked';
    }

    approval.failures += 1;

    if (approval.failures >= MAX_FAILURES) {
      this.pending.delete(key);

      return 'locked';
    }

    return 'retry';
  }

  removePending(key: string): void {
    this.pending.delete(key);
  }

  recordApproved(sessionID: string, approved: Omit<ApprovedRequest, 'expiresAt'>): void {
    this.approved.set(sessionID, { ...approved, expiresAt: this.now() + this.pendingMs });
  }

  // What an owner session approved, or null once it expired or went.
  findApproved(sessionID: string): ApprovedRequest | null {
    this.dropExpired(this.now());

    return this.approved.get(sessionID) ?? null;
  }

  removeApproved(sessionID: string): void {
    this.approved.delete(sessionID);
  }

  private dropExpired(now: number): void {
    for (const [key, approval] of this.pending) {
      if (approval.expiresAt <= now) {
        this.pending.delete(key);
      }
    }

    for (const [sessionID, approved] of this.approved) {
      if (approved.expiresAt <= now) {
        this.approved.delete(sessionID);
      }
    }
  }
}
