import { lookup } from 'node:dns/promises';
import { isRecord, systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import { MAX_LINE } from '@atc/protocol/wire';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Server } from 'bun';
import invariant from 'tiny-invariant';
import { APPROVAL_WINDOW_SECONDS } from '../auth/approval-window-seconds';
import { createApprovalState } from '../auth/create-approval-state';
import { createEnrollmentState } from '../auth/create-enrollment-state';
import { createSecurityEventLog } from '../auth/create-security-event-log';
import type { MCPAuthDatabase } from '../auth/mcp-auth-database';
import { openMCPAuth } from '../auth/open-mcp-auth';
import type { HTTPServerContext, Requester, VerifiedAccess } from '../auth/types';
import { createEventDeliverer } from '../events/create-event-deliverer';
import { createWebhookSender } from '../events/create-webhook-sender';
import { probeReadAccess } from '../events/probe-read-access';
import { registerEventMethods } from '../events/register-event-methods';
import type { WebhookSender } from '../events/types';
import { buildPrincipalCaller } from '../tools/build-principal-caller';
import { createMCPServer } from '../tools/create-mcp-server';
import type { FleetCaller } from '../tools/types';
import { createMCPHTTPApp } from './create-mcp-http-app';
import { createModernMCPHandler } from './create-modern-mcp-handler';
import { isLoopbackHost } from './is-loopback-host';
import { normalizePublicURL } from './normalize-public-url';

interface MCPHTTPServerOptions {
  readonly caller: FleetCaller;
  readonly build: string;

  // The address to bind; 0 as the port binds a free one.
  readonly host: string;
  readonly port: number;

  // The origin clients reach the server at; absent means the local address.
  readonly publicURL: string | null;

  // Further Host header values to accept, for a proxy that rewrites Host.
  readonly allowedHosts: readonly string[];

  // The socket peers whose `CF-Connecting-IP` header a security event
  // labels `trusted`, each exactly as the socket reports its address.
  readonly trustForwardedFrom: readonly string[];

  // The authorization server's SQLite database, and the opener the entry
  // wires in for it.
  readonly dbPath: string;
  readonly openAuthDatabase: (path: string) => MCPAuthDatabase;

  // Receives one line per request the server answers.
  readonly printRequest: (line: string) => void;

  // Receives one `atc security {json}` line per sign-in outcome or refused token.
  readonly printSecurity: (line: string) => void;

  // How long a rotated refresh token still answers with its successor.
  readonly refreshReuseSeconds?: number;

  // Serves `/healthz` and `/readyz` for an orchestrator's probes.
  readonly probes?: boolean;

  // The time pending approvals, their challenges, the limit on approval
  // starts, and the routes' expiries run on; the system clock when unset.
  readonly clock?: Clock;

  // Posts MCP Events webhooks; a sender that reaches only public addresses
  // over https when unset.
  readonly sendWebhook?: WebhookSender;
}

export interface MCPHTTPServer {
  // The loopback address the server answers on, for clients on this machine.
  readonly url: string;

  // The address the server is bound to.
  readonly listening: string;

  // The public origin: the OAuth issuer.
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

// The JSON-RPC method and tool name of an MCP request, for its request line.
interface RPCLabel {
  readonly method: string;
  readonly tool: string | null;
}

export async function startMCPHTTPServer(options: MCPHTTPServerOptions): Promise<MCPHTTPServer> {
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

  const security = createSecurityEventLog({ print: options.printSecurity, clock });

  const trustedProxies: ReadonlySet<string> = new Set(options.trustForwardedFrom);

  const holder: {
    ctx: HTTPServerContext | null;
    app: ReturnType<typeof createMCPHTTPApp> | null;
  } = { ctx: null, app: null };

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

  // The JSON-RPC label of each MCP request the app let through, for its
  // request line.
  const labels = new WeakMap<Request, RPCLabel | null>();

  const answerRequest = async (request: Request): Promise<Response> => {
    const startedAt = performance.now();

    // Bun runs a request's fetch on a later turn than the one that bound the
    // port, and that turn builds the app.
    invariant(holder.app, 'a request arrived before the server built its app');

    const response = await holder.app.handle(request);

    const rpc = labels.get(request) ?? null;

    options.printRequest(
      formatRequestLine(request, rpc, response.status, performance.now() - startedAt),
    );

    return response;
  };

  const server: Server<undefined> = Bun.serve({
    hostname: options.host,
    port: options.port,

    // A long poll holds a request open for up to 30 seconds without a byte.
    idleTimeout: 60,
    maxRequestBodySize: MAX_LINE,
    fetch: answerRequest,
  });

  const port = server.port ?? options.port;
  const local = `http://127.0.0.1:${port}`;
  const origin = publicOrigin ?? local;

  holder.app = createMCPHTTPApp({
    hosts: new Set([
      new URL(origin).host,
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      ...options.allowedHosts,
    ]),
    origins: new Set([origin, local, `http://localhost:${port}`]),
    probes: options.probes === true,
    readContext: () => holder.ctx,
    readRequester,
    onMCPRequest: async (request) => {
      const label = await readRPCLabel(request);

      labels.set(request, label);
    },
    security,
  });

  let store: HTTPServerContext['store'];

  try {
    store = await openMCPAuth({
      dbPath: options.dbPath,
      openDatabase: options.openAuthDatabase,
      origin,
      ...(options.refreshReuseSeconds === undefined
        ? {}
        : { refreshReuseSeconds: options.refreshReuseSeconds }),
    });
  } catch (error) {
    await server.stop(true);

    throw error;
  }

  const sendWebhook =
    options.sendWebhook ??
    createWebhookSender({
      resolveHost: resolveAddresses,
      transport: (target, init) => fetch(target, init),
    });

  const deliverer = createEventDeliverer({
    db: store.db,
    caller: options.caller,
    send: sendWebhook,
    clock,
    probeAccess: (clientID) => probeReadAccess(store.db, clientID, clock.now()),
    log: options.printRequest,
  });

  const modern = createModernMCPHandler({
    createServer: (access) => {
      invariant(holder.ctx, 'a modern request arrived before the server built its context');

      return createPrincipalServer(holder.ctx, access);
    },
  });

  holder.ctx = {
    caller: options.caller,
    build: options.build,
    origin,
    resource: `${origin}/mcp`,
    store,
    approvals: createApprovalState(APPROVAL_WINDOW_SECONDS * 1000, () => clock.now()),
    enrollments: createEnrollmentState(() => clock.now()),
    security,
    clock,
    modern,
    deliverer,
    sendWebhook,
  };

  await deliverer.start();

  return {
    url: local,
    listening: formatBindURL(options.host, port),
    origin,
    stop: async () => {
      deliverer.stop();

      await server.stop(true);
      await modern.close();
      await store.close();

      security.drain();
    },
  };
}

// Client-sent values in a request line are cut to this many characters.
const LABEL_LENGTH = 64;

// The line names the path without its query, which carries authorization
// codes and signed state.
function formatRequestLine(
  request: Request,
  rpc: RPCLabel | null,
  status: number,
  durationMs: number,
): string {
  const path = new URL(request.url).pathname;

  const version = request.headers.get('mcp-protocol-version');

  const fields = [
    request.method,
    toLogText(path, 128),
    String(status),
    `${Math.round(durationMs)}ms`,
    ...(rpc === null ? [] : [`rpc=${toLogText(rpc.method, LABEL_LENGTH)}`]),
    ...(rpc === null || rpc.tool === null ? [] : [`tool=${toLogText(rpc.tool, LABEL_LENGTH)}`]),
    ...(version === null ? [] : [`mcp-protocol-version=${toLogText(version, LABEL_LENGTH)}`]),
  ];

  return fields.join(' ');
}

// Control and format characters are dropped, so a client cannot write
// escape sequences into the operator's terminal.
function toLogText(value: string, length: number): string {
  return value.replaceAll(/[\p{Cc}\p{Cf}\s]/gu, '').slice(0, length);
}

// The method and tool of an MCP request, read from a copy of its body, so
// the route still reads the body itself.
async function readRPCLabel(request: Request): Promise<RPCLabel | null> {
  const body = await request.clone().text();

  let message: unknown;

  try {
    message = JSON.parse(body);
  } catch {
    return null;
  }

  if (!isRecord(message) || typeof message['method'] !== 'string') {
    return null;
  }

  const params = message['params'];

  return {
    method: message['method'],
    tool: isRecord(params) && typeof params['name'] === 'string' ? params['name'] : null,
  };
}

async function resolveAddresses(hostname: string): Promise<readonly string[]> {
  const found = await lookup(hostname, { all: true });

  return found.map((entry) => entry.address);
}

// A server for one modern request, with the tools and the event methods the
// request's token allows.
function createPrincipalServer(ctx: HTTPServerContext, access: VerifiedAccess): McpServer {
  const caller = buildPrincipalCaller(ctx.caller, { id: access.clientID, name: access.clientName });

  const server = createMCPServer({
    caller,
    build: ctx.build,
    toolContext: { callerSessionID: null },
    scopes: access.scopes,
  });

  registerEventMethods(server, {
    db: ctx.store.db,
    caller,
    clientID: access.clientID,
    send: ctx.sendWebhook,
    clock: ctx.clock,
    deliverer: ctx.deliverer,
  });

  return server;
}

// An IPv6 address takes the brackets a URL puts around it.
function formatBindURL(host: string, port: number): string {
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  return `http://${bracketed}:${port}`;
}
