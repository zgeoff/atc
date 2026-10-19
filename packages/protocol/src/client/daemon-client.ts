import { isRecord } from '@atc/core';
import { createORPCClient } from '@orpc/client';
import { StandardRPCLink } from '@orpc/client/standard';
import type { ContractRouterClient } from '@orpc/contract';
import { ClientPeer } from '@orpc/standard-server-peer';
import type { SocketHandler } from 'bun';
import type { DAEMON_CONTRACT } from '../daemon-contract';
import type { DaemonEvent } from '../daemon-event';
import type { DaemonChannel, HelloOptions } from '../wire/daemon-channel';
import { DaemonError } from '../wire/daemon-error';
import { LineDecoder } from '../wire/line-decoder';
import { OutboundQueue } from '../wire/outbound-queue';
import { PRINCIPAL_HEADERS } from '../wire/principal-headers';
import { PROTOCOL_V } from '../wire/protocol';
import { toDaemonError } from './to-daemon-error';

// The principal one call acts as, and the name that labels a message it
// sends.
interface CallContext {
  readonly as?: string | undefined;
  readonly asName?: string | undefined;
}

export type DaemonProcedures = ContractRouterClient<typeof DAEMON_CONTRACT, CallContext>;

// A connection to the daemon that speaks oRPC peer messages, one JSON
// message per line, and delivers the connection's events through its
// subscription once the handshake passes.
export class DaemonClient implements DaemonChannel {
  onEvent: (event: DaemonEvent) => void = () => {};

  onClose: () => void = () => {};

  // Sees each answer before its request resolves with it. A throw rejects
  // the request with the thrown message as an `internal` error.
  onAnswer: (method: string, ok: Readonly<Record<string, unknown>>) => void = () => {};

  // The principal a request acts as when it gives none. A daemon serves a
  // request over TCP only as a principal, so a client that reaches one over
  // TCP sets it once its handshake has passed instead of on every request.
  principal: string | undefined = undefined;

  // Every procedure, typed by the contract; a refusal rejects with a
  // DaemonError.
  readonly procedures: DaemonProcedures;

  private readonly link: StandardRPCLink<CallContext>;

  private readonly peer: ClientPeer;

  private readonly lines = new LineDecoder();

  private queue: OutboundQueue | null = null;

  private socket: { end: () => void } | null = null;

  private events: AbortController | null = null;

  // The lines read so far, each handed to the peer after the one before.
  private inbound: Promise<void> = Promise.resolve();

  // Set once the connection ends, so a request sent afterwards rejects at
  // once instead of waiting on a response that can never arrive.
  private closedReason: string | null = null;

  private constructor() {
    this.peer = new ClientPeer((message) => {
      if (typeof message !== 'string' || this.queue?.send(`${message}\n`) === false) {
        throw new DaemonError('internal', 'outbound queue full');
      }
    });

    this.link = new StandardRPCLink<CallContext>(
      {
        call: async (request) => {
          const response = await this.peer.request(request);

          return { ...response, body: () => Promise.resolve(response.body) };
        },
      },
      {
        url: 'http://orpc',
        headers: (options) => buildPrincipalHeaders(options.context),
        interceptors: [
          async (options) => {
            try {
              return await options.next();
            } catch (error) {
              throw toDaemonError(error);
            }
          },
        ],
      },
    );

    this.procedures = createORPCClient<DaemonProcedures>(this.link);
  }

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

      // The lines that arrived before the close settle their requests first,
      // so a refusal the daemon wrote before it ended reaches its caller.
      close() {
        client.closedReason ??= 'connection closed';

        void (async () => {
          await client.inbound;

          client.drainPending('connection closed');
          client.onClose();
        })();
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

  // a client inside an atc session gives that session, so the daemon never
  // takes a change to the session's own record from it; the connection's
  // events start once the handshake passes
  async sendHello(
    build: string,
    options: HelloOptions = {},
  ): Promise<Readonly<Record<string, unknown>>> {
    const hello = await this.sendRequest('daemon.hello', {
      client: build,
      protocol: PROTOCOL_V,
      auth:
        options.token === undefined
          ? { scheme: 'none' }
          : { scheme: 'bearer', token: options.token },
      ...(options.session === undefined ? {} : { session: options.session }),
      ...(options.principal === undefined ? {} : { principal: options.principal }),
    });

    this.startEvents();

    return hello;
  }

  // A request with a principal acts as that principal, and carries its name
  // when one is given.
  async sendRequest(
    m: string,
    p?: Readonly<Record<string, unknown>>,
    as?: string,
    asName?: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (this.closedReason !== null) {
      throw new DaemonError('internal', this.closedReason);
    }

    const principal = as ?? this.principal;
    const context = { as: principal, asName: principal === undefined ? undefined : asName };

    const answer: unknown = await this.link.call(m.split('.'), p ?? {}, { context });

    const ok = isRecord(answer) ? answer : {};

    try {
      this.onAnswer(m, ok);
    } catch (error) {
      throw new DaemonError('internal', String(error));
    }

    return ok;
  }

  stop(): void {
    this.socket?.end();
    this.drainPending('client closed');
  }

  private startEvents(): void {
    if (this.events !== null) {
      return;
    }

    const controller = new AbortController();

    this.events = controller;

    void (async () => {
      try {
        const stream = await this.procedures.events.subscribe({}, { signal: controller.signal });

        for await (const event of stream) {
          this.onEvent(event);
        }
      } catch {
        // The stream ends with the connection.
      }
    })();
  }

  // A line from a daemon that speaks the older line protocol carries a
  // version and no message id; it refuses the client, so every request
  // still waiting rejects with the mismatch.
  private applyChunk(buf: Uint8Array): void {
    for (const line of this.lines.splitChunk(buf)) {
      if (isLineProtocolAnswer(line)) {
        this.drainPending(
          'the daemon speaks an older protocol; restart the daemon so both run the same build',
          'protocol_mismatch',
        );

        this.socket?.end();

        return;
      }

      this.inbound = this.applyLineAfter(this.inbound, line);
    }
  }

  private async applyLineAfter(previous: Promise<void>, line: string): Promise<void> {
    await previous;

    await this.applyLine(line);
  }

  private async applyLine(line: string): Promise<void> {
    try {
      await this.peer.message(line);
    } catch {
      this.socket?.end();
    }
  }

  private drainPending(reason: string, code: 'internal' | 'protocol_mismatch' = 'internal'): void {
    this.closedReason ??= reason;
    this.events?.abort();
    this.peer.close({ reason: new DaemonError(code, reason) });
  }
}

function buildPrincipalHeaders(context: CallContext): Record<string, string> {
  return {
    ...(context.as === undefined ? {} : { [PRINCIPAL_HEADERS.as]: context.as }),
    ...(context.as === undefined || context.asName === undefined
      ? {}
      : { [PRINCIPAL_HEADERS.asName]: context.asName }),
  };
}

function isLineProtocolAnswer(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);

    return isRecord(parsed) && typeof parsed['v'] === 'number' && parsed['i'] === undefined;
  } catch {
    return false;
  }
}
