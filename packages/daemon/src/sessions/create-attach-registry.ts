import type { SessionID } from '@atc/core';

export interface Dims {
  readonly cols: number;
  readonly rows: number;
}

export interface AttachRegistry<TClient> {
  readonly attach: (sessionID: SessionID, client: TClient, dims: Dims) => void;
  readonly removeClient: (sessionID: SessionID, client: TClient) => boolean;
  readonly detachAll: (client: TClient) => SessionID[];
  readonly removeSession: (sessionID: SessionID) => void;
  readonly hasClient: (sessionID: SessionID, client: TClient) => boolean;
  readonly updateDims: (sessionID: SessionID, client: TClient, dims: Dims) => boolean;
  readonly collectClients: (sessionID: SessionID) => TClient[];
  readonly findEffectiveDims: (sessionID: SessionID) => Dims | null;
}

export function createAttachRegistry<TClient>(): AttachRegistry<TClient> {
  const bySession = new Map<SessionID, Map<TClient, Dims>>();

  return {
    attach: (sessionID, client, dims) => {
      const clients = bySession.get(sessionID) ?? new Map<TClient, Dims>();

      clients.set(client, dims);
      bySession.set(sessionID, clients);
    },

    removeClient: (sessionID, client) => {
      const clients = bySession.get(sessionID);
      const removed = clients?.delete(client) ?? false;

      if (clients !== undefined && clients.size === 0) {
        bySession.delete(sessionID);
      }

      return removed;
    },

    detachAll: (client) => {
      const affected: SessionID[] = [];

      for (const [sessionID, clients] of bySession) {
        if (clients.delete(client)) {
          affected.push(sessionID);
        }

        if (clients.size === 0) {
          bySession.delete(sessionID);
        }
      }

      return affected;
    },

    removeSession: (sessionID) => {
      bySession.delete(sessionID);
    },

    hasClient: (sessionID, client) => bySession.get(sessionID)?.has(client) ?? false,

    updateDims: (sessionID, client, dims) => {
      const clients = bySession.get(sessionID);

      if (clients === undefined || !clients.has(client)) {
        return false;
      }

      clients.set(client, dims);

      return true;
    },

    collectClients: (sessionID) => [...(bySession.get(sessionID)?.keys() ?? [])],

    findEffectiveDims: (sessionID) => {
      const clients = bySession.get(sessionID);

      if (clients === undefined || clients.size === 0) {
        return null;
      }

      let cols = Number.POSITIVE_INFINITY;
      let rows = Number.POSITIVE_INFINITY;

      // the smallest across clients, so every attached terminal can render the whole screen
      for (const dims of clients.values()) {
        cols = Math.min(cols, dims.cols);
        rows = Math.min(rows, dims.rows);
      }

      return { cols, rows };
    },
  };
}
