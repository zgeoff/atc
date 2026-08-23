import { DaemonError } from '../protocol/daemon-error';
import { OutboundQueue } from '../protocol/outbound-queue';
import { PROTOCOL_V, decodeMessage, encodeMessage } from '../protocol/protocol';
import type { EventMsg, ResponseMsg } from '../protocol/protocol';

interface Pending {
  readonly resolve: (ok: Readonly<Record<string, unknown>>) => void;
  readonly reject: (err: Readonly<DaemonError>) => void;
}

/**
 * A protocol connection to the daemon: correlated request/response plus an
 * event callback. `open` connects the socket; `sendHello` completes the
 * handshake and must come first.
 */
export class DaemonClient {
  onEvent: (event: EventMsg) => void = () => {};

  private queue: OutboundQueue | null = null;

  private buffer = '';

  private nextID = 1;

  private readonly pending = new Map<number, Pending>();

  private socket: { end: () => void } | null = null;

  static async open(socketPath: string): Promise<DaemonClient> {
    const client = new DaemonClient();

    const socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, buf) {
          client.applyChunk(buf.toString());
        },
        drain() {
          client.queue?.drain();
        },
        close() {
          client.drainPending('connection closed');
        },
        error() {},
      },
    });

    client.socket = socket;

    client.queue = new OutboundQueue(socket, 8 * 1024 * 1024);

    return client;
  }

  sendHello(build: string): Promise<Readonly<Record<string, unknown>>> {
    return this.sendRequest('daemon.hello', { client: build, auth: { scheme: 'none' } });
  }

  sendRequest(
    m: string,
    p?: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const id = this.nextID++;
    const resolvers = Promise.withResolvers<Readonly<Record<string, unknown>>>();

    this.pending.set(id, { resolve: resolvers.resolve, reject: resolvers.reject });
    this.queue?.send(encodeMessage({ v: PROTOCOL_V, id, m, ...(p === undefined ? {} : { p }) }));

    return resolvers.promise;
  }

  stop(): void {
    this.socket?.end();
    this.drainPending('client closed');
  }

  private applyChunk(chunk: string): void {
    this.buffer += chunk;

    const lines = this.buffer.split('\n');

    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim() === '') {
        continue;
      }

      this.applyLine(line);
    }
  }

  private applyLine(line: string): void {
    const decoded = decodeMessage(line);

    if (decoded.kind === 'event') {
      this.onEvent(decoded.msg);

      return;
    }

    if (decoded.kind !== 'response') {
      return;
    }

    this.applyResponse(decoded.msg);
  }

  private applyResponse(msg: ResponseMsg): void {
    const waiter = this.pending.get(msg.id);

    if (waiter === undefined) {
      return;
    }

    this.pending.delete(msg.id);

    if (msg.err === undefined) {
      waiter.resolve(msg.ok ?? {});
    } else {
      waiter.reject(new DaemonError(msg.err.code, msg.err.msg));
    }
  }

  private drainPending(reason: string): void {
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
      waiter.reject(new DaemonError('internal', reason));
    }
  }
}
