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

interface CodeEntry extends IssuedCode {
  claimed: boolean;
  grantID: string | null;
  revokeWhenGranted: boolean;
}

type CodeClaim =
  | { readonly kind: 'claimed'; readonly code: IssuedCode }
  | { readonly kind: 'reused'; readonly grantID: string | null }
  | { readonly kind: 'unknown' };

// At most this many approvals wait at once, and at most this many start per hour.
const MAX_PENDING = 5;
const MAX_PER_HOUR = 20;
const MAX_ATTEMPTS = 5;

/**
 * The authorization server's short-lived state, held in memory by the HTTP
 * process: approvals waiting for the operator, and authorization codes waiting
 * for exchange. Codes are kept by hash and stay after exchange until they
 * expire, so a second exchange is recognized as reuse.
 */
export class AuthorizationState {
  private readonly limits: AuthorizationLimits;

  private readonly now: () => number;

  private readonly pending = new Map<string, PendingApproval>();

  private readonly codes = new Map<string, CodeEntry>();

  private startedAt: number[] = [];

  constructor(limits: AuthorizationLimits, now: () => number) {
    this.limits = limits;
    this.now = now;
  }

  createPending(request: AuthorizationRequest): PendingApproval | null {
    const now = this.now();

    this.removeExpired(now);

    this.startedAt = this.startedAt.filter((at) => now - at < 3_600_000);

    if (this.pending.size >= MAX_PENDING || this.startedAt.length >= MAX_PER_HOUR) {
      return null;
    }

    const approval: PendingApproval = {
      ...request,
      id: mintToken('atc_ac_'),
      approvalCode: mintApprovalCode(),
      attempts: 0,
      expiresAt: now + this.limits.pendingMs,
    };

    this.pending.set(approval.id, approval);
    this.startedAt.push(now);

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
      ...code,
      expiresAt: this.now() + this.limits.codeMs,
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

    return { kind: 'claimed', code: entry };
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
    for (const [id, approval] of this.pending) {
      if (approval.expiresAt <= now) {
        this.pending.delete(id);
      }
    }

    for (const [hash, entry] of this.codes) {
      if (entry.expiresAt <= now) {
        this.codes.delete(hash);
      }
    }
  }
}
