import { randomUUID } from 'node:crypto';
import type { SessionID } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';

interface ConfirmTokensDeps {
  // The clock tokens are minted and checked against, in epoch milliseconds.
  readonly now: () => number;

  // How long a token stays usable after it is minted.
  readonly lifetimeMs: number;
}

// One token a forget handed out: the session it forgets, when it stops
// being taken, and whether a forget took it.
interface ConfirmToken {
  readonly session: SessionID;
  readonly expiresAt: number;
  readonly used: boolean;
}

export interface ConfirmTokens {
  readonly mintToken: (session: SessionID) => {
    readonly confirmToken: string;
    readonly expiresAt: number;
  };

  // Throws `confirm_token_invalid` with the reason for a token that is
  // unknown, held for another session, used, or expired.
  readonly claimToken: (session: SessionID, token: string) => void;
}

export function createConfirmTokens(deps: ConfirmTokensDeps): ConfirmTokens {
  const now = deps.now;
  const lifetimeMs = deps.lifetimeMs;

  const tokens = new Map<string, ConfirmToken>();

  return {
    mintToken: (session) => {
      const confirmToken = randomUUID();
      const expiresAt = now() + lifetimeMs;

      tokens.set(confirmToken, { session, expiresAt, used: false });

      return { confirmToken, expiresAt };
    },

    claimToken: (session, token) => {
      const claimedAt = now();

      // an expired token stays known for one more lifetime, so a late forget learns it expired
      for (const [held, entry] of tokens) {
        if (entry.expiresAt + lifetimeMs < claimedAt) {
          tokens.delete(held);
        }
      }

      const entry = tokens.get(token);
      let reason: 'unknown' | 'used' | 'expired' | null = null;

      if (entry === undefined || entry.session !== session) {
        reason = 'unknown';
      } else if (entry.used) {
        reason = 'used';
      } else if (entry.expiresAt <= claimedAt) {
        reason = 'expired';
      }

      if (reason !== null) {
        throw new DaemonError(
          'confirm_token_invalid',
          `confirm token for session ${session} is ${reason}; call session.forget without a token for a new one`,
          { reason },
        );
      }

      tokens.set(token, { session, expiresAt: entry?.expiresAt ?? claimedAt, used: true });
    },
  };
}
