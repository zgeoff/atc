import type { MessageID } from '../shared/message-id';
import type { SessionID } from '../shared/session-id';

interface TapEntry<TClient> {
  readonly client: TClient;
  readonly claimed: Set<MessageID>;
}

/**
 * Which connection taps each session's inbox; one tap per session, the
 * latest wins; each message is handed to a tap once.
 */
export class TapRegistry<TClient> {
  private readonly bySession = new Map<SessionID, TapEntry<TClient>>();

  /**
   * Makes the client the session's tap and returns the client it displaced,
   * or null when there was none or it is the same connection.
   */
  attach(sessionID: SessionID, client: TClient): TClient | null {
    const previous = this.bySession.get(sessionID)?.client ?? null;

    this.bySession.set(sessionID, { client, claimed: new Set() });

    return previous === client ? null : previous;
  }

  detachAll(client: TClient): void {
    for (const [sessionID, entry] of this.bySession) {
      if (entry.client === client) {
        this.bySession.delete(sessionID);
      }
    }
  }

  /**
   * Forgets the session's tap and returns its client, or null when the
   * session had none.
   */
  removeSession(sessionID: SessionID): TClient | null {
    const previous = this.bySession.get(sessionID)?.client ?? null;

    this.bySession.delete(sessionID);

    return previous;
  }

  hasTap(sessionID: SessionID): boolean {
    return this.bySession.has(sessionID);
  }

  isTap(sessionID: SessionID, client: TClient): boolean {
    return this.bySession.get(sessionID)?.client === client;
  }

  claimDelivery(sessionID: SessionID, messageID: MessageID): TClient | null {
    const entry = this.bySession.get(sessionID);

    if (entry === undefined || entry.claimed.has(messageID)) {
      return null;
    }

    entry.claimed.add(messageID);

    return entry.client;
  }
}
