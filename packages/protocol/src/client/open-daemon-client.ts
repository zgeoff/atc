import { isRecord } from '@atc/core';
import { createORPCClient } from '@orpc/client';
import { StandardRPCLink } from '@orpc/client/standard';
import { ClientPeer } from '@orpc/standard-server-peer';
import type { SocketHandler } from 'bun';
import { createActor } from 'xstate';
import type { Actor } from 'xstate';
import { DaemonError } from '../wire/daemon-error';
import { LineDecoder } from '../wire/line-decoder';
import { OutboundQueue } from '../wire/outbound-queue';
import { PRINCIPAL_HEADERS } from '../wire/principal-headers';
import { PROTOCOL_V } from '../wire/protocol';
import { CLIENT_MACHINE } from './client-machine';
import type { CallContext, DaemonClient, DaemonProcedures } from './daemon-client';
import { toDaemonError } from './to-daemon-error';

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

    conn.queue = new OutboundQueue(socket, QUEUE_BYTES);
  } catch (error) {
    conn.actor.stop();
    throw error;
  }

  return client;
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
    lines: new LineDecoder(),
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
      sendClientRequest(conn, client, 'daemon.hello', {
        client: build,
        auth:
          options.token === undefined
            ? { scheme: 'none' }
            : { scheme: 'bearer', token: options.token },
        ...(options.session === undefined ? {} : { session: options.session }),
        ...(options.principal === undefined ? {} : { principal: options.principal }),
      }),
    sendRequest: (m, p, as, asName) => sendClientRequest(conn, client, m, p, as, asName),
    stop: () => {
      conn.socket?.end();
      drainPending(conn, 'client closed');
    },
  };

  conn.findDefaultPrincipal = () => client.principal ?? null;

  return client;
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
      conn.actor.send({ type: 'CLOSE', reason: 'connection closed' });

      void (async () => {
        await conn.inbound;

        drainPending(conn, 'connection closed');

        // A close handler that throws is reported, never left unhandled.
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

// A request with a principal acts as that principal and carries its name.
// A handshake gives this client's protocol version unless its params give
// one, and the connection's events start once it passes.
async function sendClientRequest(
  conn: ClientConnection,
  client: DaemonClient,
  m: string,
  p?: Readonly<Record<string, unknown>>,
  as?: string,
  asName?: string,
): Promise<Readonly<Record<string, unknown>>> {
  const hello = m === 'daemon.hello';
  const principal = as ?? client.principal;
  const context = { as: principal, asName: principal === undefined ? undefined : asName };
  const params = hello ? { protocol: PROTOCOL_V, ...p } : (p ?? {});

  const answer: unknown = await conn.link.call(m.split('.'), params, { context });

  const ok = isRecord(answer) ? answer : {};

  try {
    client.onAnswer(m, ok);
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

// A line from a daemon that speaks the older line protocol carries a
// version and no message id; it refuses the client, so every request still
// waiting rejects with the mismatch.
function applyChunk(conn: ClientConnection, buf: Uint8Array): void {
  for (const line of conn.lines.splitChunk(buf)) {
    if (isLineProtocolAnswer(line)) {
      drainPending(
        conn,
        'the daemon speaks an older protocol; restart the daemon so both run the same build',
        'protocol_mismatch',
      );

      conn.socket?.end();

      return;
    }

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

function drainPending(
  conn: ClientConnection,
  reason: string,
  code: 'internal' | 'protocol_mismatch' = 'internal',
): void {
  conn.actor.send({ type: 'CLOSE', reason });
  conn.events?.abort();
  conn.peer.close({ reason: new DaemonError(code, reason) });
}

function requireOpenConnection(conn: ClientConnection): void {
  const closedReason = conn.actor.getSnapshot().context.closedReason;

  if (closedReason !== null) {
    throw new DaemonError('internal', closedReason);
  }
}

function isClientClosed(conn: ClientConnection): boolean {
  return conn.actor.getSnapshot().matches('closed');
}

function findHelloPrincipal(params: Readonly<Record<string, unknown>>): string | undefined {
  const principal = params['principal'];

  return typeof principal === 'string' ? principal : undefined;
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
