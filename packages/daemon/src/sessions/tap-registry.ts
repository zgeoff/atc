import type { MessageID, SessionID } from '@atc/core';

interface TapEntry<TClient> {
  readonly client: TClient;

  // The deliveries the tap took, each keyed by its kind and message id.
  readonly claimed: Set<string>;

  // Whether the tap also takes messages held under the session's agent
  // session id, as opposed to its atc id alone.
  readonly linked: boolean;

  // Whether the tap also takes the answer notices of the messages its
  // session sent.
  readonly notices: boolean;

  // Which attach made this tap; every attach makes a new one.
  readonly generation: number;
}

export interface TapGeneration {
  readonly generation: number;
  readonly linked: boolean;
  readonly notices: boolean;
}

export type TapDeliveryKind = 'message' | 'notice';

export class TapRegistry<TClient> {
  private readonly bySession = new Map<SessionID, TapEntry<TClient>>();

  private nextGeneration = 0;

  attach(sessionID: SessionID, client: TClient, linked = true, notices = false): TClient | null {
    const previous = this.bySession.get(sessionID)?.client ?? null;

    this.nextGeneration += 1;

    this.bySession.set(sessionID, {
      client,
      claimed: new Set(),
      linked,
      notices,
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

  removeSession(sessionID: SessionID): TClient | null {
    const previous = this.bySession.get(sessionID)?.client ?? null;

    this.bySession.delete(sessionID);

    return previous;
  }

  findTap(sessionID: SessionID): TapGeneration | null {
    const entry = this.bySession.get(sessionID);

    return entry === undefined
      ? null
      : { generation: entry.generation, linked: entry.linked, notices: entry.notices };
  }

  hasTap(sessionID: SessionID): boolean {
    return this.bySession.has(sessionID);
  }

  isTap(sessionID: SessionID, client: TClient): boolean {
    return this.bySession.get(sessionID)?.client === client;
  }

  claimDelivery(
    sessionID: SessionID,
    messageID: MessageID,
    generation: number,
    kind: TapDeliveryKind = 'message',
  ): TClient | null {
    const entry = this.bySession.get(sessionID);

    // a message and its notice are claimed apart, since a session can
    // message itself
    const key = `${kind}:${messageID}`;

    if (entry === undefined || entry.generation !== generation || entry.claimed.has(key)) {
      return null;
    }

    entry.claimed.add(key);

    return entry.client;
  }
}
