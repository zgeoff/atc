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

/**
 * The confirm tokens a forget on a host-destroying target hands out, by
 * token. A token is taken once, for its own session, before it expires. It
 * stays known for one more lifetime after it expires, so a late forget
 * learns that it expired rather than that it never existed.
 */
export class ConfirmTokens {
  private readonly now: () => number;

  private readonly lifetimeMs: number;

  private readonly tokens = new Map<string, ConfirmToken>();

  constructor(deps: ConfirmTokensDeps) {
    this.now = deps.now;
    this.lifetimeMs = deps.lifetimeMs;
  }

  mintToken(session: SessionID): { readonly confirmToken: string; readonly expiresAt: number } {
    const confirmToken = randomUUID();
    const expiresAt = this.now() + this.lifetimeMs;

    this.tokens.set(confirmToken, { session, expiresAt, used: false });

    return { confirmToken, expiresAt };
  }

  // Throws `confirm_token_invalid` with the reason for a token that is
  // unknown, held for another session, used, or expired.
  claimToken(session: SessionID, token: string): void {
    const now = this.now();

    for (const [held, entry] of this.tokens) {
      if (entry.expiresAt + this.lifetimeMs < now) {
        this.tokens.delete(held);
      }
    }

    const entry = this.tokens.get(token);
    let reason: 'unknown' | 'used' | 'expired' | null = null;

    if (entry === undefined || entry.session !== session) {
      reason = 'unknown';
    } else if (entry.used) {
      reason = 'used';
    } else if (entry.expiresAt <= now) {
      reason = 'expired';
    }

    if (reason !== null) {
      throw new DaemonError(
        'confirm_token_invalid',
        `confirm token for session ${session} is ${reason}; call session.forget without a token for a new one`,
        { reason },
      );
    }

    this.tokens.set(token, { session, expiresAt: entry?.expiresAt ?? now, used: true });
  }
}
