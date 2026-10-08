import type { SocketHandler } from 'bun';
import type { DaemonChannel } from '../protocol/daemon-channel';
import { DaemonError } from '../protocol/daemon-error';
import { LineDecoder } from '../protocol/line-decoder';
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
export class DaemonClient implements DaemonChannel {
  onEvent: (event: EventMsg) => void = () => {};

  onClose: () => void = () => {};

  private queue: OutboundQueue | null = null;

  private readonly lines = new LineDecoder();

  private nextID = 1;

  private readonly pending = new Map<number, Pending>();

  private socket: { end: () => void } | null = null;

  // Set once the connection ends, so a request sent afterwards rejects at
  // once instead of waiting on a response that can never arrive.
  private closedReason: string | null = null;

  // Connects to the daemon at a unix socket path, or at a TCP address.
  static async open(
    address: string | { readonly hostname: string; readonly port: number },
  ): Promise<DaemonClient> {
    const client = new DaemonClient();

    const handlers: SocketHandler = {
      data(_s, buf) {
        client.applyChunk(buf);
      },
      drain() {
        client.queue?.drain();
      },
      close() {
        client.drainPending('connection closed');
        client.onClose();
      },
      error() {},
    };

    const socket =
      typeof address === 'string'
        ? await Bun.connect({ unix: address, socket: handlers })
        : await Bun.connect({ hostname: address.hostname, port: address.port, socket: handlers });

    client.socket = socket;

    client.queue = new OutboundQueue(socket, 8 * 1024 * 1024);

    return client;
  }

  // A handshake with a token presents it as a bearer token, which a TCP
  // listener requires. A client started inside an atc session gives that
  // session, so the daemon never takes a change to the session's own record
  // from it.
  sendHello(build: string, token?: string): Promise<Readonly<Record<string, unknown>>> {
    const session = process.env['ATC_SESSION_ID'];

    return this.sendRequest('daemon.hello', {
      client: build,
      auth: token === undefined ? { scheme: 'none' } : { scheme: 'bearer', token },
      ...(session === undefined || session === '' ? {} : { session }),
    });
  }

  // A request with a principal acts as that principal, within what the
  // connection may reach.
  sendRequest(
    m: string,
    p?: Readonly<Record<string, unknown>>,
    as?: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (this.closedReason !== null) {
      return Promise.reject(new DaemonError('internal', this.closedReason));
    }

    const id = this.nextID++;
    const resolvers = Promise.withResolvers<Readonly<Record<string, unknown>>>();

    this.pending.set(id, { resolve: resolvers.resolve, reject: resolvers.reject });

    this.queue?.send(
      encodeMessage({
        v: PROTOCOL_V,
        id,
        m,
        ...(p === undefined ? {} : { p }),
        ...(as === undefined ? {} : { as }),
      }),
    );

    return resolvers.promise;
  }

  stop(): void {
    this.socket?.end();
    this.drainPending('client closed');
  }

  // oxlint-disable-next-line prefer-readonly-parameter-types -- a socket read buffer has no readonly form
  private applyChunk(buf: Uint8Array): void {
    for (const line of this.lines.splitChunk(buf)) {
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
      waiter.reject(new DaemonError(msg.err.code, msg.err.msg, msg.err.data));
    }
  }

  private drainPending(reason: string): void {
    this.closedReason ??= reason;

    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
      waiter.reject(new DaemonError('internal', reason));
    }
  }
}
