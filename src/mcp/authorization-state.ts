import type { GrantScope } from '../shared/grant-scope';
import { deriveTokenHash } from './derive-token-hash';
import { mintApprovalCode } from './mint-approval-code';
import { mintToken } from './mint-token';
import { normalizeApprovalCode } from './normalize-approval-code';
import type { OAuthClientView } from './types';

interface AuthorizationLimits {
  // How long an approval waits for the operator's code.
  readonly pendingMs: number;

  // How long an authorization code stays exchangeable.
  readonly codeMs: number;
}

interface AuthorizationRequest {
  readonly client: OAuthClientView;
  readonly redirectURI: string;
  readonly state: string | null;
  readonly codeChallenge: string;
  readonly scopes: readonly GrantScope[];
  readonly resource: string;
}

/**
 * An authorization request waiting for the operator to type its approval code.
 */
export interface PendingApproval extends AuthorizationRequest {
  readonly id: string;
  readonly approvalCode: string;
  attempts: number;
  readonly expiresAt: number;
}

/**
 * An authorization code the token endpoint can exchange once.
 */
export interface IssuedCode {
  readonly clientID: string;
  readonly clientName: string;
  readonly redirectURI: string;
  readonly codeChallenge: string;
  readonly scopes: readonly GrantScope[];
  readonly resource: string;
  readonly expiresAt: number;
}

interface CodeEntry {
  readonly code: IssuedCode;
  claimed: boolean;
  grantID: string | null;
  revokeWhenGranted: boolean;
}

type CodeClaim =
  | { readonly kind: 'claimed'; readonly code: IssuedCode }
  | { readonly kind: 'reused'; readonly grantID: string | null }
  | { readonly kind: 'unknown' };

// At most this many approvals wait at once across every client, each client
// holds at most one, and each client starts at most this many per hour.
const MAX_PENDING = 5;
const MAX_PER_CLIENT_PER_HOUR = 20;
const MAX_ATTEMPTS = 5;

// How many clients' hourly starts are remembered at once; past this, the
// client that started one least recently is forgotten.
const MAX_TRACKED_CLIENTS = 1000;
const HOUR_MS = 3_600_000;

/**
 * The authorization server's short-lived state, held in memory by the HTTP
 * process: approvals waiting for the operator, and authorization codes waiting
 * for exchange. A client's new approval replaces its waiting one, and a full
 * set of waiting approvals makes room by dropping the oldest, so no client can
 * hold the operator's approvals hostage. Codes are kept by hash and stay after
 * exchange until they expire, so a second exchange is recognized as reuse.
 */
export class AuthorizationState {
  private readonly limits: AuthorizationLimits;

  private readonly now: () => number;

  private readonly pending = new Map<string, PendingApproval>();

  private readonly codes = new Map<string, CodeEntry>();

  // Each client's approval start times within the last hour, least recently
  // started client first.
  private readonly startedAt = new Map<string, readonly number[]>();

  constructor(limits: AuthorizationLimits, now: () => number) {
    this.limits = limits;
    this.now = now;
  }

  // Returns null when the client has used its hourly budget.
  createPending(request: AuthorizationRequest): PendingApproval | null {
    const now = this.now();
    const clientID = request.client.clientID;

    this.removeExpired(now);

    const recent = (this.startedAt.get(clientID) ?? []).filter((at) => now - at < HOUR_MS);

    if (recent.length >= MAX_PER_CLIENT_PER_HOUR) {
      return null;
    }

    for (const [id, approval] of this.pending) {
      if (approval.client.clientID === clientID) {
        this.pending.delete(id);
      }
    }

    const oldest = this.pending.keys().next();

    if (this.pending.size >= MAX_PENDING && oldest.done !== true) {
      this.pending.delete(oldest.value);
    }

    const approval: PendingApproval = {
      ...request,
      id: mintToken('atc_ac_'),
      approvalCode: mintApprovalCode(),
      attempts: 0,
      expiresAt: now + this.limits.pendingMs,
    };

    this.pending.set(approval.id, approval);
    this.recordStart(clientID, [...recent, now]);

    return approval;
  }

  findPending(id: string): PendingApproval | null {
    this.removeExpired(this.now());

    return this.pending.get(id) ?? null;
  }

  // A wrong code counts against the approval; the last allowed miss drops it.
  verifyApprovalCode(id: string, typed: string): 'ok' | 'wrong' | 'locked' {
    const approval = this.findPending(id);

    if (approval === null) {
      return 'locked';
    }

    if (normalizeApprovalCode(typed) === approval.approvalCode) {
      this.pending.delete(id);

      return 'ok';
    }

    approval.attempts += 1;

    if (approval.attempts >= MAX_ATTEMPTS) {
      this.pending.delete(id);

      return 'locked';
    }

    return 'wrong';
  }

  removePending(id: string): void {
    this.pending.delete(id);
  }

  createCode(code: Omit<IssuedCode, 'expiresAt'>): string {
    const token = mintToken('atc_ac_');

    this.codes.set(deriveTokenHash(token), {
      code: { ...code, expiresAt: this.now() + this.limits.codeMs },
      claimed: false,
      grantID: null,
      revokeWhenGranted: false,
    });

    return token;
  }

  claimCode(token: string): CodeClaim {
    this.removeExpired(this.now());

    const entry = this.codes.get(deriveTokenHash(token));

    if (entry === undefined) {
      return { kind: 'unknown' };
    }

    if (entry.claimed) {
      entry.revokeWhenGranted = entry.grantID === null;

      return { kind: 'reused', grantID: entry.grantID };
    }

    entry.claimed = true;

    return { kind: 'claimed', code: entry.code };
  }

  // Records the grant a claimed code produced. Returns true when the code was
  // presented again before the grant existed, so the caller revokes it.
  updateCodeGrant(token: string, grantID: string): boolean {
    const entry = this.codes.get(deriveTokenHash(token));

    if (entry === undefined) {
      return false;
    }

    entry.grantID = grantID;

    return entry.revokeWhenGranted;
  }

  private removeExpired(now: number): void {
    for (const [clientID, starts] of this.startedAt) {
      if (starts.every((at) => now - at >= HOUR_MS)) {
        this.startedAt.delete(clientID);
      }
    }

    for (const [id, approval] of this.pending) {
      if (approval.expiresAt <= now) {
        this.pending.delete(id);
      }
    }

    for (const [hash, entry] of this.codes) {
      if (entry.code.expiresAt <= now) {
        this.codes.delete(hash);
      }
    }
  }

  private recordStart(clientID: string, starts: readonly number[]): void {
    this.startedAt.delete(clientID);
    this.startedAt.set(clientID, starts);

    const leastRecent = this.startedAt.keys().next();

    if (this.startedAt.size > MAX_TRACKED_CLIENTS && leastRecent.done !== true) {
      this.startedAt.delete(leastRecent.value);
    }
  }
}
