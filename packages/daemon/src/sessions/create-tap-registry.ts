import type { MessageID, SessionID } from '@atcx/contract';

interface TapEntry<TClient> {
  readonly client: TClient;

  readonly claimed: Set<string>;

  readonly linked: boolean;

  readonly notices: boolean;

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

  readonly subscribeToDetach: (listener: (sessionID: SessionID) => void) => () => void;

  readonly subscribeToAttach: (listener: (sessionID: SessionID) => void) => () => void;

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
  const attachListeners = new Set<(sessionID: SessionID) => void>();

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

      for (const listener of attachListeners) {
        listener(sessionID);
      }

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

    subscribeToAttach: (listener) => {
      attachListeners.add(listener);

      return () => {
        attachListeners.delete(listener);
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
