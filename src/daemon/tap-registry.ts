import type { MessageID } from '../shared/message-id';
import type { SessionID } from '../shared/session-id';

interface TapEntry<TClient> {
  readonly client: TClient;
  readonly claimed: Set<MessageID>;

  // Whether the tap also takes messages held under the session's agent
  // session id, as opposed to its atc id alone.
  readonly linked: boolean;

  // Which attach made this tap; every attach makes a new one.
  readonly generation: number;
}

/**
 * A session's tap as a drain finds it before it waits: the attach that made
 * it and whether it is linked. A delivery made for it lands only while the
 * same attach holds the tap.
 */
export interface TapGeneration {
  readonly generation: number;
  readonly linked: boolean;
}

/**
 * Which connection taps each session's inbox; one tap per session, the
 * latest wins; each message is handed to a tap once.
 */
export class TapRegistry<TClient> {
  private readonly bySession = new Map<SessionID, TapEntry<TClient>>();

  private nextGeneration = 0;

  /**
   * Makes the client the session's tap and returns the client it displaced,
   * or null when there was none or it is the same connection. A linked tap
   * also takes the messages held under the session's agent session id.
   */
  attach(sessionID: SessionID, client: TClient, linked = true): TClient | null {
    const previous = this.bySession.get(sessionID)?.client ?? null;

    this.nextGeneration += 1;

    this.bySession.set(sessionID, {
      client,
      claimed: new Set(),
      linked,
      generation: this.nextGeneration,
    });

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

  findTap(sessionID: SessionID): TapGeneration | null {
    const entry = this.bySession.get(sessionID);

    return entry === undefined ? null : { generation: entry.generation, linked: entry.linked };
  }

  hasTap(sessionID: SessionID): boolean {
    return this.bySession.has(sessionID);
  }

  isTap(sessionID: SessionID, client: TClient): boolean {
    return this.bySession.get(sessionID)?.client === client;
  }

  /**
   * Claims the message for the session's tap and returns its client, or
   * null when the tap already took it or another attach replaced the tap
   * the delivery was made for.
   */
  claimDelivery(sessionID: SessionID, messageID: MessageID, generation: number): TClient | null {
    const entry = this.bySession.get(sessionID);

    if (entry === undefined || entry.generation !== generation || entry.claimed.has(messageID)) {
      return null;
    }

    entry.claimed.add(messageID);

    return entry.client;
  }
}
