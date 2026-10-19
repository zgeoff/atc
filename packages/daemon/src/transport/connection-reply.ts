import { DaemonError, PROTOCOL_V, encodeMessage } from '@atc/protocol/wire';
import type { ErrorCode, OutboundQueue } from '@atc/protocol/wire';

interface ClosablePeer {
  readonly end: () => void;
}

// The answers one connection writes to its client, each through the
// connection's outbound queue.
export class ConnectionReply {
  private readonly queue: OutboundQueue;

  private readonly peer: ClosablePeer;

  constructor(queue: OutboundQueue, peer: ClosablePeer) {
    this.queue = queue;
    this.peer = peer;
  }

  // A store query that rejects must end one request, never the daemon: a
  // floating promise here would take the whole process down with it. A
  // rejection that carries a protocol error code answers with that code.
  answerAsync(id: number, answered: () => Promise<void>): void {
    void (async () => {
      try {
        await answered();
      } catch (error) {
        if (error instanceof DaemonError) {
          this.sendErr(id, error.code, error.message, error.data);

          return;
        }

        const reason = error instanceof Error ? error.message : String(error);

        this.sendErr(id, 'internal', reason);
      }
    })();
  }

  // An answer the full queue refuses ends the connection, as an event does,
  // so the client sees its request fail rather than wait for an answer
  // that never comes.
  sendAnswer(id: number, ok: Readonly<Record<string, unknown>>): void {
    if (!this.queue.send(encodeMessage({ v: PROTOCOL_V, id, ok }))) {
      this.peer.end();
    }
  }

  sendErr(
    id: number,
    code: ErrorCode,
    msg: string,
    data?: Readonly<Record<string, unknown>>,
  ): void {
    const queued = this.queue.send(
      encodeMessage({
        v: PROTOCOL_V,
        id,
        err: { code, msg, ...(data === undefined ? {} : { data }) },
      }),
    );

    if (!queued) {
      this.peer.end();
    }
  }
}
