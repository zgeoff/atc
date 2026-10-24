import type { MessageID, SessionID } from '@atcx/contract';

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

type TapDeliveryKind = 'message' | 'notice';

export interface TapRegistry<TClient> {
  readonly attach: (
    sessionID: SessionID,
    client: TClient,
    linked?: boolean,
    notices?: boolean,
  ) => TClient | null;

  readonly detachAll: (client: TClient) => void;
  readonly removeSession: (sessionID: SessionID) => TClient | null;

  // Hears each session whose tap leaves, with no tap in its place; a tap
  // that another replaces is no departure.
  readonly subscribeToDetach: (listener: (sessionID: SessionID) => void) => () => void;

  readonly findTap: (sessionID: SessionID) => TapGeneration | null;
  readonly hasTap: (sessionID: SessionID) => boolean;
  readonly isTap: (sessionID: SessionID, client: TClient) => boolean;

  readonly claimDelivery: (
    sessionID: SessionID,
    messageID: MessageID,
    generation: number,
    kind?: TapDeliveryKind,
  ) => TClient | null;
}

export function createTapRegistry<TClient>(): TapRegistry<TClient> {
  const bySession = new Map<SessionID, TapEntry<TClient>>();

  let nextGeneration = 0;

  const detachListeners = new Set<(sessionID: SessionID) => void>();

  const emitDetached = (sessionID: SessionID): void => {
    for (const listener of detachListeners) {
      listener(sessionID);
    }
  };

  return {
    attach: (sessionID, client, linked = true, notices = false) => {
      const previous = bySession.get(sessionID)?.client ?? null;

      nextGeneration += 1;

      bySession.set(sessionID, {
        client,
        claimed: new Set(),
        linked,
        notices,
        generation: nextGeneration,
      });

      return previous === client ? null : previous;
    },

    detachAll: (client) => {
      for (const [sessionID, entry] of bySession) {
        if (entry.client === client) {
          bySession.delete(sessionID);

          emitDetached(sessionID);
        }
      }
    },

    removeSession: (sessionID) => {
      const previous = bySession.get(sessionID)?.client ?? null;

      bySession.delete(sessionID);

      if (previous !== null) {
        emitDetached(sessionID);
      }

      return previous;
    },

    subscribeToDetach: (listener) => {
      detachListeners.add(listener);

      return () => {
        detachListeners.delete(listener);
      };
    },

    findTap: (sessionID) => {
      const entry = bySession.get(sessionID);

      return entry === undefined
        ? null
        : { generation: entry.generation, linked: entry.linked, notices: entry.notices };
    },

    hasTap: (sessionID) => bySession.has(sessionID),

    isTap: (sessionID, client) => bySession.get(sessionID)?.client === client,

    claimDelivery: (sessionID, messageID, generation, kind = 'message') => {
      const entry = bySession.get(sessionID);

      // a message and its notice are claimed apart, since a session can
      // message itself
      const key = `${kind}:${messageID}`;

      if (entry === undefined || entry.generation !== generation || entry.claimed.has(key)) {
        return null;
      }

      entry.claimed.add(key);

      return entry.client;
    },
  };
}
