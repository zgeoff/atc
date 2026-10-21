import { randomBytes } from 'node:crypto';
import type { TakenChallenge } from './create-approval-state';

// At most this many enrollment challenges wait at once; a new one past the
// limit drops the oldest.
const MAX_CHALLENGES = 8;

// How long an enrollment page's challenge stays valid.
const CHALLENGE_MS = 5 * 60_000;

export interface EnrollmentState {
  readonly mintChallenge: (tokenHash: string) => string;

  // Takes the token's challenge, so it verifies at most one registration.
  readonly claimChallenge: (tokenHash: string) => TakenChallenge;
}

export function createEnrollmentState(now: () => number): EnrollmentState {
  const challenges = new Map<string, { readonly value: string; readonly expiresAt: number }>();

  return {
    mintChallenge: (tokenHash) => {
      challenges.delete(tokenHash);

      const oldest = challenges.keys().next();

      if (challenges.size >= MAX_CHALLENGES && oldest.done !== true) {
        challenges.delete(oldest.value);
      }

      const value = randomBytes(32).toString('base64url');

      challenges.set(tokenHash, { value, expiresAt: now() + CHALLENGE_MS });

      return value;
    },

    claimChallenge: (tokenHash) => {
      const challenge = challenges.get(tokenHash);

      if (challenge === undefined) {
        return { kind: 'missing' };
      }

      challenges.delete(tokenHash);

      if (challenge.expiresAt <= now()) {
        return { kind: 'expired' };
      }

      return { kind: 'taken', challenge: challenge.value };
    },
  };
}
