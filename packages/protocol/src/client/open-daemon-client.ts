import { isRecord } from '@atc/core';
import { createORPCClient } from '@orpc/client';
import { StandardRPCLink } from '@orpc/client/standard';
import { ClientPeer } from '@orpc/standard-server-peer';
import type { SocketHandler } from 'bun';
import { createActor } from 'xstate';
import type { Actor } from 'xstate';
import { createLineDecoder } from '../wire/create-line-decoder';
import type { LineDecoder } from '../wire/create-line-decoder';
import { createOutboundQueue } from '../wire/create-outbound-queue';
import type { OutboundQueue } from '../wire/create-outbound-queue';
import { DaemonError } from '../wire/daemon-error';
import { PRINCIPAL_HEADERS } from '../wire/principal-headers';
import { PROTOCOL_V } from '../wire/protocol';
import { CLIENT_MACHINE } from './client-machine';
import type { CallContext, DaemonClient, DaemonProcedures } from './daemon-client';
import { toDaemonError } from './to-daemon-error';

const QUEUE_BYTES = 8 * 1024 * 1024;

// Connects to the daemon at a unix socket path, or at a TCP address.
export async function openDaemonClient(
  address: string | { readonly hostname: string; readonly port: number },
): Promise<DaemonClient> {
  const conn = createClientConnection();
  const client = buildDaemonClient(conn);
  const handlers = buildSocketHandlers(conn, client);

  try {
    const socket =
      typeof address === 'string'
        ? await Bun.connect({ unix: address, socket: handlers })
        : await Bun.connect({ hostname: address.hostname, port: address.port, socket: handlers });

    conn.socket = socket;
    conn.queue = createOutboundQueue(socket, QUEUE_BYTES);
  } catch (error) {
    conn.actor.stop();
    throw error;
  }

  return client;
}

// What one client connection holds: its lifecycle, the peer that pairs
// requests with responses, and the socket and queue once it connects.
interface ClientConnection {
  readonly actor: Actor<typeof CLIENT_MACHINE>;
  readonly lines: LineDecoder;
  readonly peer: ClientPeer;
  readonly link: StandardRPCLink<CallContext>;
  readonly procedures: DaemonProcedures;
  queue: OutboundQueue | null;
  socket: { readonly end: () => void } | null;
  events: AbortController | null;

  // The lines read so far, each handed to the peer after the one before.
  inbound: Promise<void>;

  // The principal a call acts as when it gives none: the client's own.
  findDefaultPrincipal: () => string | null;
}

function createClientConnection(): ClientConnection {
  // The peer sends only once the connection below holds its queue.
  const peer = new ClientPeer((message) => {
    if (typeof message !== 'string' || conn.queue?.send(`${message}\n`) === false) {
      throw new DaemonError('internal', 'outbound queue full');
    }
  });

  const link = new StandardRPCLink<CallContext>(
    {
      // Every call, a typed procedure's included, refuses at once on a
      // closed connection with the reason it closed.
      call: async (request) => {
        requireOpenConnection(conn);

        const response = await peer.request(request);

        return { ...response, body: () => Promise.resolve(response.body) };
      },
    },
    {
      url: 'http://orpc',
      headers: (options) =>
        buildPrincipalHeaders({
          ...options.context,
          as: options.context.as ?? conn.findDefaultPrincipal() ?? undefined,
        }),
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

  const conn: ClientConnection = {
    actor: createActor(CLIENT_MACHINE).start(),
    lines: createLineDecoder(),
    peer,
    link,
    procedures: createORPCClient<DaemonProcedures>(link),
    queue: null,
    socket: null,
    events: null,
    inbound: Promise.resolve(),
    findDefaultPrincipal: () => null,
  };

  return conn;
}

function requireOpenConnection(conn: ClientConnection): void {
  const closedReason = conn.actor.getSnapshot().context.closedReason;

  if (closedReason !== null) {
    throw new DaemonError('internal', closedReason);
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

function buildDaemonClient(conn: ClientConnection): DaemonClient {
  const client: DaemonClient = {
    onEvent: () => {},
    onClose: () => {},
    onAnswer: () => {},
    principal: undefined,
    procedures: conn.procedures,
    isClosed: () => isClientClosed(conn),

    // a client inside an atc session gives that session, so the daemon
    // never takes a change to the session's own record from it
    sendHello: (build, options = {}) =>
      sendClientRequest(conn, client, {
        method: 'daemon.hello',
        params: {
          client: build,
          auth:
            options.token === undefined
              ? { scheme: 'none' }
              : { scheme: 'bearer', token: options.token },
          ...(options.session === undefined ? {} : { session: options.session }),
          ...(options.principal === undefined ? {} : { principal: options.principal }),
          ...(options.viewer === undefined ? {} : { viewer: options.viewer }),
        },
      }),
    sendRequest: (method, params, as, asName) =>
      sendClientRequest(conn, client, { method, params, as, asName }),
    stop: () => {
      conn.socket?.end();
      drainPending(conn, 'client closed');
    },
  };

  conn.findDefaultPrincipal = () => client.principal ?? null;

  return client;
}

function isClientClosed(conn: ClientConnection): boolean {
  return conn.actor.getSnapshot().matches('closed');
}

interface SendClientRequestOptions {
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>> | undefined;
  readonly as?: string | undefined;
  readonly asName?: string | undefined;
}

// A request with a principal acts as that principal and carries its name.
// A handshake gives this client's protocol version unless its params give
// one, and the connection's events start once it passes.
async function sendClientRequest(
  conn: ClientConnection,
  client: DaemonClient,
  request: SendClientRequestOptions,
): Promise<Readonly<Record<string, unknown>>> {
  const method = request.method;
  const hello = method === 'daemon.hello';
  const principal = request.as ?? client.principal;

  const context = {
    as: principal,
    asName: principal === undefined ? undefined : request.asName,
  };

  const params = hello ? { protocol: PROTOCOL_V, ...request.params } : (request.params ?? {});

  const answer: unknown = await conn.link.call(method.split('.'), params, { context });

  const ok = isRecord(answer) ? answer : {};

  try {
    client.onAnswer(method, ok);
  } catch (error) {
    throw new DaemonError('internal', String(error));
  }

  if (hello) {
    startClientEvents(conn, client, principal ?? findHelloPrincipal(params));
  }

  return ok;
}

// The subscription acts as the principal the handshake gave, which a
// daemon reached over TCP requires of every request.
function startClientEvents(
  conn: ClientConnection,
  client: DaemonClient,
  principal: string | undefined,
): void {
  if (!conn.actor.getSnapshot().can({ type: 'SUBSCRIBE' })) {
    return;
  }

  conn.actor.send({ type: 'SUBSCRIBE' });

  const controller = new AbortController();

  conn.events = controller;
  void readClientEvents(conn, client, controller.signal, principal);
}

// A subscription that fails or ends while its connection stays open, a
// throw from the event handler included, closes the connection with the
// reason, so the caller sees the loss and every later request gets it.
async function readClientEvents(
  conn: ClientConnection,
  client: DaemonClient,
  signal: AbortSignal,
  principal: string | undefined,
): Promise<void> {
  let failure = 'the daemon ended the event subscription';

  try {
    const stream = await conn.procedures.events.subscribe(
      {},
      { signal, context: { as: principal } },
    );

    for await (const event of stream) {
      client.onEvent(event);
    }
  } catch (error) {
    failure = `the event subscription failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (signal.aborted || isClientClosed(conn)) {
    return;
  }

  drainPending(conn, failure);
  conn.socket?.end();
}

function drainPending(conn: ClientConnection, reason: string): void {
  sendClose(conn, reason);
  conn.events?.abort();
  conn.peer.close({ reason: new DaemonError('internal', reason) });
}

// A closed client's machine has stopped, and takes no event.
function sendClose(conn: ClientConnection, reason: string): void {
  if (!isClientClosed(conn)) {
    conn.actor.send({ type: 'CLOSE', reason });
  }
}

function findHelloPrincipal(params: Readonly<Record<string, unknown>>): string | undefined {
  const principal = params['principal'];

  return typeof principal === 'string' ? principal : undefined;
}

// The lines that arrived before the close settle their requests first, so
// a refusal the daemon wrote before it ended reaches its caller.
function buildSocketHandlers(conn: ClientConnection, client: DaemonClient): SocketHandler {
  return {
    data(_s, buf) {
      applyChunk(conn, buf);
    },
    drain() {
      conn.queue?.drain();
    },
    close() {
      sendClose(conn, 'connection closed');

      void (async () => {
        await conn.inbound;

        drainPending(conn, 'connection closed');

        try {
          client.onClose();
        } catch (error) {
          console.error(`atc: the daemon client's close handler failed: ${String(error)}`);
        }
      })();
    },
    error() {},
  };
}

function applyChunk(conn: ClientConnection, buf: Uint8Array): void {
  for (const line of conn.lines.splitChunk(buf)) {
    conn.inbound = applyLineAfter(conn, conn.inbound, line);
  }
}

async function applyLineAfter(
  conn: ClientConnection,
  previous: Promise<void>,
  line: string,
): Promise<void> {
  await previous;

  try {
    await conn.peer.message(line);
  } catch {
    conn.socket?.end();
  }
}
