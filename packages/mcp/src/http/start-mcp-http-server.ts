import type { Database } from 'bun:sqlite';
import { lookup } from 'node:dns/promises';
import { MAX_LINE } from '@atc/protocol/wire';
import { GATEWAY_PATHS } from '@atcx/contract';
import type { GrantScope } from '@atcx/contract';
import type { ServiceTokenFile } from '@zgeoff/mcp-auth';
import { createMCPHTTPApp } from '@zgeoff/mcp-auth/elysia';
import type { Clock } from '@zgeoff/std';
import { systemClock } from '@zgeoff/std';
import type { Server } from 'bun';
import { Elysia, NotFound } from 'elysia';
import invariant from 'tiny-invariant';
import { createSecurityEventLog } from '../auth/create-security-event-log';
import { openATCAuth } from '../auth/open-atc-auth';
import type { ATCAuth } from '../auth/open-atc-auth';
import type { HTTPServerContext, Requester } from '../auth/types';
import { createEventDeliverer } from '../events/create-event-deliverer';
import { createSubscriptionStore } from '../events/create-subscription-store';
import { createWebhookSender } from '../events/create-webhook-sender';
import { isPublicAddress } from '../events/is-public-address';
import { openEventDatabase } from '../events/open-event-database';
import { removeUnreadableSubscriptions } from '../events/remove-unreadable-subscriptions';
import type { WebhookSender } from '../events/types';
import type { FleetCaller } from '../tools/types';
import { answerMCPRequest } from './answer-mcp-request';
import { answerPTYRequest } from './answer-pty-request';
import type { PTYRoute } from './answer-pty-request';
import { createModernMCPHandler } from './create-modern-mcp-handler';
import { createPrincipalServer } from './create-principal-server';
import type { PTYViewer, WatchChannel } from './create-pty-viewer';
import { formatRequestLine } from './format-request-line';
import { isLabelledRequest } from './is-labelled-request';
import { isLoopbackHost } from './is-loopback-host';
import { normalizePublicURL } from './normalize-public-url';
import { parsePTYPath } from './parse-pty-path';
import { PTY_PROTOCOL } from './parse-pty-protocols';
import { readRPCLabel } from './read-rpc-label';

interface LiveTerminalOptions {
  readonly allowedOrigins: readonly string[];

  // The tokens of the owner's token file, each of which opens a live
  // terminal as the daemon's owner; empty without one. They need a loopback
  // bind.
  readonly ownerTokens: readonly string[];

  readonly openWatchChannel: (principal: string | null) => Promise<WatchChannel>;

  readonly viewerBufferBytes?: number;

  readonly viewerAccessRecheckMs?: number;
}

interface MCPHTTPServerOptions {
  readonly caller: FleetCaller;
  readonly build: string;

  // A port of 0 makes the OS pick a free port.
  readonly host: string;
  readonly port: number;

  // The origin clients reach the server at; absent means the local address.
  readonly publicURL: string | null;

  // Further Host header values to accept, for a proxy that rewrites Host.
  readonly allowedHosts: readonly string[];

  // The socket peers whose `CF-Connecting-IP` header a security event
  // labels `trusted`, each exactly as the socket reports its address.
  readonly trustForwardedFrom: readonly string[];

  // The opener must make the file owner-only and turn foreign keys on. The server opens the
  // database twice: once for this package's tables and once for atc's event tables.
  readonly dbPath: string;
  readonly openAuthDatabase: (path: string) => Database;

  // The service tokens the server accepts on `/mcp` beside OAuth tokens; its
  // `resource` must equal the resource the server serves.
  readonly serviceTokens?: ServiceTokenFile<GrantScope>;

  readonly printRequest: (line: string) => void;

  // Receives one `atc security {json}` line per sign-in outcome or refused token.
  readonly printSecurity: (line: string) => void;

  readonly probes?: boolean;

  // The time pending approvals, their challenges, the limit on approval
  // starts, and the routes' expiries run on; the system clock when unset.
  readonly clock?: Pick<Clock, 'now' | 'schedule'>;

  // Posts MCP Events webhooks; a sender that reaches only public addresses
  // over https when unset.
  readonly sendWebhook?: WebhookSender;

  // Serves each session's live terminal over a WebSocket; without it, the
  // server answers that path as it answers any unknown one.
  readonly liveTerminals?: LiveTerminalOptions;
}

export interface MCPHTTPServer {
  readonly url: string;

  readonly listening: string;

  // The public origin: the OAuth issuer.
  readonly origin: string;

  readonly replaceServiceTokens: (file: ServiceTokenFile<GrantScope>) => void;
  readonly stop: () => Promise<void>;
}

// How many bytes a live-terminal socket holds unsent before its viewer drops
// output for a fresh snapshot: a few full screens.
const VIEWER_BUFFER_BYTES = 1_048_576;

// A revoked grant or an expired token ends a viewer's stream within one of
// these.
const VIEWER_ACCESS_RECHECK_MS = 5000;

// A callback that holds a post open past this fails it, so one slow endpoint
// cannot hold its watcher.
const WEBHOOK_TIMEOUT_MS = 10_000;
const REMOVE_EXPIRED_MS = 10 * 60 * 1000;

// atc owns paths under this prefix for its live terminals. The server answers these requests
// itself, so they never reach the adapter's routes.
const BESIDE_PREFIX = '/sessions';

const PROBE_PATHS: ReadonlySet<string> = new Set(Object.values(GATEWAY_PATHS.probes));

export async function startMCPHTTPServer(input: MCPHTTPServerOptions): Promise<MCPHTTPServer> {
  const { serviceTokens: file, ...options } = input;
  const clock = options.clock ?? systemClock;

  // Normalized before binding, so an invalid public URL throws with no port
  // left bound.
  const publicOrigin = options.publicURL === null ? null : normalizePublicURL(options.publicURL);

  // atc speaks plain HTTP, so a listener other machines can reach has to sit
  // behind something that terminates TLS, and the public URL clients use is
  // that https origin.
  if (
    !isLoopbackHost(options.host) &&
    (publicOrigin === null || !publicOrigin.startsWith('https:'))
  ) {
    throw new Error(
      `listening on '${options.host}' reaches beyond this machine, so it needs an https public URL served by a TLS-terminating proxy or tunnel`,
    );
  }

  const liveTerminals = options.liveTerminals ?? null;

  if (
    liveTerminals !== null &&
    liveTerminals.ownerTokens.length > 0 &&
    !isLoopbackHost(options.host)
  ) {
    throw new Error(
      `a token file opens live terminals as the owner, so it needs a loopback bind, not '${options.host}'`,
    );
  }

  const security = createSecurityEventLog({ print: options.printSecurity, clock });

  const trustedProxies: ReadonlySet<string> = new Set(options.trustForwardedFrom);

  const holder: {
    ctx: HTTPServerContext | null;
    answerApp: ((request: Request) => Promise<Response>) | null;
  } = { ctx: null, answerApp: null };

  // The socket's peer is the requester, or the proxy or tunnel in front of
  // atc. Only a listed peer vouches for the forwarded address.
  const readRequester = (request: Request): Requester => {
    const socketAddress = server.requestIP(request)?.address ?? null;
    const connectingIP = request.headers.get('cf-connecting-ip');

    return {
      socketAddress,
      connectingIP:
        connectingIP === null
          ? null
          : {
              address: connectingIP,
              provenance:
                socketAddress !== null && trustedProxies.has(socketAddress)
                  ? 'trusted'
                  : 'unverified',
            },
      userAgent: request.headers.get('user-agent'),
    };
  };

  const answerAppRequest = (request: Request): Response | Promise<Response> => {
    const path = new URL(request.url).pathname;

    const isProbe = options.probes === true && PROBE_PATHS.has(path);

    if (isProbe && !hosts.has(request.headers.get('host') ?? '')) {
      security.record({
        kind: 'bad_host',
        outcome: 'rejected',
        reason: 'host_not_allowed',
        path,
        requester: readRequester(request),
      });

      return new Response(null, { status: 403 });
    }

    if (isProbe) {
      return answerProbeRequest(
        request.method,
        path === GATEWAY_PATHS.probes.health || holder.answerApp !== null,
      );
    }

    if (holder.answerApp === null) {
      return new Response(null, { status: 503 });
    }

    return holder.answerApp(request);
  };

  const answerRequest = async (request: Request): Promise<Response | undefined> => {
    const startedAt = performance.now();
    const ptyPath = parsePTYPath(new URL(request.url).pathname);

    if (ptyPath.kind === 'malformed' && ptyRoute !== null) {
      options.printRequest(formatRequestLine(request, null, 400, performance.now() - startedAt));

      return new Response(null, { status: 400 });
    }

    if (ptyPath.kind === 'session' && ptyRoute !== null) {
      const answered = await answerPTYRequest(ptyRoute, holder.ctx, {
        request,
        sessionID: ptyPath.sessionID,
        upgrade: (viewer) =>
          server.upgrade(request, {
            data: viewer,
            headers: { 'sec-websocket-protocol': PTY_PROTOCOL },
          }),
      });

      options.printRequest(
        formatRequestLine(request, null, answered?.status ?? 101, performance.now() - startedAt),
      );

      return answered;
    }

    // Read once the Host and Origin headers pass and before the bearer token
    // is checked, so a request refused for its token names its method.
    const rpc = isLabelledRequest(request, hosts, origins) ? await readRPCLabel(request) : null;

    const response = await answerAppRequest(request);

    options.printRequest(
      formatRequestLine(request, rpc, response.status, performance.now() - startedAt),
    );

    return response;
  };

  const server: Server<PTYViewer> = Bun.serve({
    hostname: options.host,
    port: options.port,

    // A long poll holds a request open for up to 30 seconds without a byte.
    idleTimeout: 60,
    maxRequestBodySize: MAX_LINE,
    fetch: answerRequest,
    websocket: {
      // A viewer takes no input, so a frame from the browser ends nothing
      // and does nothing.
      message: () => {},
      open: (socket) => {
        socket.data.open({
          send: (frame) => {
            socket.send(frame);
          },
          getBufferedAmount: () => socket.getBufferedAmount(),
          close: (code, reason) => {
            socket.close(code, reason);
          },
        });
      },
      drain: (socket) => {
        socket.data.drain();
      },
      close: (socket) => {
        socket.data.close();
      },
    },
  });

  const port = server.port ?? options.port;
  const local = `http://127.0.0.1:${port}`;
  const origin = publicOrigin ?? local;

  const hosts: ReadonlySet<string> = new Set([
    new URL(origin).host,
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    ...options.allowedHosts,
  ]);

  const origins: ReadonlySet<string> = new Set([origin, local, `http://localhost:${port}`]);

  const ptyRoute: PTYRoute | null =
    liveTerminals === null
      ? null
      : {
          hosts,
          allowedOrigins: new Set(liveTerminals.allowedOrigins),
          ownerTokens: liveTerminals.ownerTokens,
          maxBufferedBytes: liveTerminals.viewerBufferBytes ?? VIEWER_BUFFER_BYTES,
          accessRecheckMs: liveTerminals.viewerAccessRecheckMs ?? VIEWER_ACCESS_RECHECK_MS,
          openWatchChannel: liveTerminals.openWatchChannel,
          readRequester,
          security,
        };

  const authDatabase = options.openAuthDatabase(options.dbPath);
  const eventDatabase = options.openAuthDatabase(options.dbPath);
  const events = openEventDatabase(eventDatabase);
  let auth: ATCAuth;

  try {
    auth = await openATCAuth({
      database: authDatabase,
      origin,
      clock,
      security,
      serviceTokens: file ?? null,
      onGrantRevoked: () => {
        removeUnreadableSubscriptions(events, (clientID) => probeReadAccess(auth, clientID)).catch(
          (error: unknown) => {
            options.printRequest(
              `atc mcp --http: could not end the subscriptions of a revoked grant: ${String(error)}`,
            );
          },
        );
      },
    });
  } catch (error) {
    await server.stop(true);
    await events.destroy();

    authDatabase.close();
    eventDatabase.close();
    throw error;
  }

  const sendWebhook =
    options.sendWebhook ??
    createWebhookSender({
      resolveHost: resolveAddresses,
      isAllowedAddress: isPublicAddress,
      transport: (target, init) => fetch(target, init),
      timeoutMs: WEBHOOK_TIMEOUT_MS,
    });

  const deliverer = createEventDeliverer({
    db: events,
    subscriptions: createSubscriptionStore(events),
    caller: options.caller,
    send: sendWebhook,
    clock,
    probeAccess: (clientID) => probeReadAccess(auth, clientID),
    log: options.printRequest,
  });

  const modern = createModernMCPHandler({
    createServer: (access) => {
      invariant(holder.ctx, 'a modern request arrived before the server built its context');

      return createPrincipalServer(holder.ctx, access);
    },
  });

  const ctx: HTTPServerContext = {
    caller: options.caller,
    build: options.build,
    origin,
    auth,
    events,
    security,
    clock,
    modern,
    deliverer,
    sendWebhook,
  };

  holder.ctx = ctx;

  const app = new Elysia()
    .onError((context) =>
      context.error instanceof NotFound
        ? new Response(null, { status: 404 })
        : new Response(null, { status: 503 }),
    )
    .use(
      createMCPHTTPApp({
        auth,
        hosts,
        origins,
        readRequester,
        security,
        mcp: {
          // oxlint-disable-next-line zgeoff/function-verb -- the adapter's option names its handler fetch
          fetch: (request, access) => answerMCPRequest(ctx, request, access),
        },
        besidePrefix: BESIDE_PREFIX,
      }),
    );

  holder.answerApp = (request) => app.handle(request);

  const removeExpiredRows = async (): Promise<void> => {
    try {
      await auth.removeExpired();
    } catch (error) {
      options.printRequest(`atc mcp --http: could not remove expired grants: ${String(error)}`);
    }
  };

  const removeExpired = setInterval(() => {
    void removeExpiredRows();
  }, REMOVE_EXPIRED_MS);

  await deliverer.start();

  return {
    url: local,
    listening: formatBindURL(options.host, port),
    origin,
    replaceServiceTokens: (replacement) => {
      auth.replaceServiceTokens(replacement);
    },
    stop: async () => {
      clearInterval(removeExpired);

      deliverer.stop();

      await server.stop(true);
      await modern.close();
      await auth.close();
      await events.destroy();

      authDatabase.close();
      eventDatabase.close();
      security.drain();
    },
  };
}

// The body stays empty on purpose, so whoever sends a probe learns nothing about the fleet.
function answerProbeRequest(method: string, ready: boolean): Response {
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  return new Response(null, { status: ready ? 200 : 503 });
}

async function probeReadAccess(auth: ATCAuth, clientID: string): Promise<boolean> {
  const scopes = await auth.findClientScopes(clientID);

  return scopes?.includes('read') ?? false;
}

async function resolveAddresses(hostname: string): Promise<readonly string[]> {
  const found = await lookup(hostname, { all: true });

  return found.map((entry) => entry.address);
}

// URL syntax requires brackets around an IPv6 host; without them its colons read as a port.
function formatBindURL(host: string, port: number): string {
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  return `http://${bracketed}:${port}`;
}
