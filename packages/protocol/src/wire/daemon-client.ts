import type { SocketHandler } from 'bun';
import type { DaemonChannel, HelloOptions } from './daemon-channel';
import { DaemonError } from './daemon-error';
import { LineDecoder } from './line-decoder';
import { OutboundQueue } from './outbound-queue';
import { PROTOCOL_V, decodeMessage, encodeMessage } from './protocol';
import type { EventMsg, ResponseMsg } from './protocol';

interface Pending {
  readonly method: string;
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

  // Sees each answer before its request resolves with it. A throw rejects
  // the request with the thrown message as an `internal` error.
  onAnswer: (method: string, ok: Readonly<Record<string, unknown>>) => void = () => {};

  // The principal a request acts as when it gives none. A daemon serves a
  // request over TCP only as a principal, so a client that reaches one over
  // TCP sets it once its handshake has passed instead of on every request.
  principal: string | undefined = undefined;

  private queue: OutboundQueue | null = null;

  private readonly lines = new LineDecoder();

  private nextID = 1;

  private readonly pending = new Map<number, Pending>();

  private socket: { end: () => void } | null = null;

  // Set once the connection ends, so a request sent afterwards rejects at
  // once instead of waiting on a response that can never arrive.
  private closedReason: string | null = null;

  isClosed(): boolean {
    return this.closedReason !== null;
  }

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
  // listener requires, and one with a principal makes the connection act as
  // that principal, which the listener's config must list. A client started inside an atc session gives that
  // session, so the daemon never takes a change to the session's own record
  // from it.
  sendHello(build: string, options: HelloOptions = {}): Promise<Readonly<Record<string, unknown>>> {
    return this.sendRequest('daemon.hello', {
      client: build,
      auth:
        options.token === undefined
          ? { scheme: 'none' }
          : { scheme: 'bearer', token: options.token },
      ...(options.session === undefined ? {} : { session: options.session }),
      ...(options.principal === undefined ? {} : { principal: options.principal }),
    });
  }

  // A request with a principal acts as that principal, within what the
  // connection may reach, and a name given beside it goes out as `asName`.
  // A request that gives none acts as the client's own principal, when it
  // has one. A request the full outbound queue refuses never reaches the wire, so it
  // rejects at once and the connection stays open for the requests already
  // queued.
  sendRequest(
    m: string,
    p?: Readonly<Record<string, unknown>>,
    as?: string,
    asName?: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (this.closedReason !== null) {
      return Promise.reject(new DaemonError('internal', this.closedReason));
    }

    const principal = as ?? this.principal;
    const id = this.nextID++;
    const resolvers = Promise.withResolvers<Readonly<Record<string, unknown>>>();

    this.pending.set(id, { method: m, resolve: resolvers.resolve, reject: resolvers.reject });

    const queued =
      this.queue === null ||
      this.queue.send(
        encodeMessage({
          v: PROTOCOL_V,
          id,
          m,
          ...(p === undefined ? {} : { p }),
          ...(principal === undefined ? {} : { as: principal }),
          ...(principal === undefined || asName === undefined ? {} : { asName }),
        }),
      );

    if (!queued) {
      this.pending.delete(id);

      return Promise.reject(new DaemonError('internal', 'outbound queue full'));
    }

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
      this.applyAnswer(waiter, msg.ok ?? {});
    } else {
      waiter.reject(new DaemonError(msg.err.code, msg.err.msg, msg.err.data));
    }
  }

  private applyAnswer(waiter: Pending, ok: Readonly<Record<string, unknown>>): void {
    try {
      this.onAnswer(waiter.method, ok);
    } catch (error) {
      waiter.reject(new DaemonError('internal', String(error)));

      return;
    }

    waiter.resolve(ok);
  }

  private drainPending(reason: string): void {
    this.closedReason ??= reason;

    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
      waiter.reject(new DaemonError('internal', reason));
    }
  }
}
