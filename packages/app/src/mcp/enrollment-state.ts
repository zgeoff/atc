import { randomBytes } from 'node:crypto';
import type { TakenChallenge } from './approval-state';

// At most this many enrollment challenges wait at once; a new one past the
// limit drops the oldest.
const MAX_CHALLENGES = 8;

// How long an enrollment page's challenge stays valid.
const CHALLENGE_MS = 5 * 60_000;

/**
 * The WebAuthn challenges of the enrollment pages in progress, held in
 * memory by the HTTP process and keyed by the hash of the enrollment token
 * each page checked. Each token holds at most one challenge, which a fresh
 * page replaces and a verification takes, so a registration signed for one
 * page or one token verifies against no other.
 */
export class EnrollmentState {
  private readonly now: () => number;

  private readonly challenges = new Map<
    string,
    { readonly value: string; readonly expiresAt: number }
  >();

  constructor(now: () => number) {
    this.now = now;
  }

  mintChallenge(tokenHash: string): string {
    this.challenges.delete(tokenHash);

    const oldest = this.challenges.keys().next();

    if (this.challenges.size >= MAX_CHALLENGES && oldest.done !== true) {
      this.challenges.delete(oldest.value);
    }

    const value = randomBytes(32).toString('base64url');

    this.challenges.set(tokenHash, { value, expiresAt: this.now() + CHALLENGE_MS });

    return value;
  }

  // Takes the token's challenge, so it verifies at most one registration.
  claimChallenge(tokenHash: string): TakenChallenge {
    const challenge = this.challenges.get(tokenHash);

    if (challenge === undefined) {
      return { kind: 'missing' };
    }

    this.challenges.delete(tokenHash);

    if (challenge.expiresAt <= this.now()) {
      return { kind: 'expired' };
    }

    return { kind: 'taken', challenge: challenge.value };
  }
}
