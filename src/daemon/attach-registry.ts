import type { SessionID } from '../shared/session-id';

export interface Dims {
  readonly cols: number;
  readonly rows: number;
}

/**
 * Which clients are subscribed to which session's output, and the dims each
 * reported. A session's effective size is the smallest reported width and
 * height across its attached clients, so every attached terminal can render
 * the whole screen.
 */
export class AttachRegistry<TClient> {
  private readonly bySession = new Map<SessionID, Map<TClient, Dims>>();

  attach(sessionID: SessionID, client: TClient, dims: Dims): void {
    const clients = this.bySession.get(sessionID) ?? new Map<TClient, Dims>();

    clients.set(client, dims);
    this.bySession.set(sessionID, clients);
  }

  detach(sessionID: SessionID, client: TClient): void {
    const clients = this.bySession.get(sessionID);

    clients?.delete(client);

    if (clients !== undefined && clients.size === 0) {
      this.bySession.delete(sessionID);
    }
  }

  detachAll(client: TClient): SessionID[] {
    const affected: SessionID[] = [];

    for (const [sessionID, clients] of this.bySession) {
      if (clients.delete(client)) {
        affected.push(sessionID);
      }

      if (clients.size === 0) {
        this.bySession.delete(sessionID);
      }
    }

    return affected;
  }

  removeSession(sessionID: SessionID): void {
    this.bySession.delete(sessionID);
  }

  hasClient(sessionID: SessionID, client: TClient): boolean {
    return this.bySession.get(sessionID)?.has(client) ?? false;
  }

  updateDims(sessionID: SessionID, client: TClient, dims: Dims): boolean {
    const clients = this.bySession.get(sessionID);

    if (clients === undefined || !clients.has(client)) {
      return false;
    }

    clients.set(client, dims);

    return true;
  }

  collectClients(sessionID: SessionID): TClient[] {
    return [...(this.bySession.get(sessionID)?.keys() ?? [])];
  }

  findEffectiveDims(sessionID: SessionID): Dims | null {
    const clients = this.bySession.get(sessionID);

    if (clients === undefined || clients.size === 0) {
      return null;
    }

    let cols = Number.POSITIVE_INFINITY;
    let rows = Number.POSITIVE_INFINITY;

    for (const dims of clients.values()) {
      cols = Math.min(cols, dims.cols);
      rows = Math.min(rows, dims.rows);
    }

    return { cols, rows };
  }
}
