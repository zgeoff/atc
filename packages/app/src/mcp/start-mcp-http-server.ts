import { isRecord, systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import { MAX_LINE } from '@atc/protocol/wire';
import type { Server } from 'bun';
import { answerAuthorizeRequest } from './answer-authorize-request';
import { answerConsentRequest } from './answer-consent-request';
import { answerEnrollRequest } from './answer-enroll-request';
import { answerLoginRequest } from './answer-login-request';
import { answerMCPRequest } from './answer-mcp-request';
import { ApprovalState } from './approval-state';
import { APPROVAL_WINDOW_SECONDS } from './approval-window-seconds';
import { buildPageResponse } from './build-page-response';
import { EnrollmentState } from './enrollment-state';
import { isLoopbackHost } from './is-loopback-host';
import type { MCPAuthDatabase } from './mcp-auth-database';
import { normalizePublicURL } from './normalize-public-url';
import { openMCPAuth } from './open-mcp-auth';
import { pickErrorMessage } from './pick-error-message';
import { recordRefusedExchange } from './record-refused-exchange';
import { SecurityEventLog } from './security-event-log';
import type { FleetCaller, HTTPServerContext, Requester } from './types';

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

const PROBE_PATHS: ReadonlySet<string> = new Set(['/healthz', '/readyz']);

interface ServerState {
  readonly hosts: ReadonlySet<string>;
  readonly origins: ReadonlySet<string>;
  readonly ctx: HTTPServerContext;
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

  const security = new SecurityEventLog({ print: options.printSecurity, clock });
  const trustedProxies: ReadonlySet<string> = new Set(options.trustForwardedFrom);

  const holder: { ready: ServerState | null; hosts: ReadonlySet<string> } = {
    ready: null,
    hosts: new Set(),
  };

  const answerRequest = async (request: Request, bunServer: Server<undefined>) => {
    const startedAt = performance.now();
    const state = holder.ready;
    let rpc: RPCLabel | null = null;
    let response: Response;

    const path = new URL(request.url).pathname;

    // The socket's peer is the requester, or the proxy or tunnel in front
    // of atc. Only a listed peer vouches for the forwarded address.
    const socketAddress = bunServer.requestIP(request)?.address ?? null;
    const connectingIP = request.headers.get('cf-connecting-ip');

    const requester: Requester = {
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

    if (options.probes === true && PROBE_PATHS.has(path)) {
      response = answerProbeRequest(request, path, holder.hosts, state !== null);

      if (response.status === 403) {
        security.record({
          kind: 'authorize_invalid',
          outcome: 'rejected',
          reason: 'bad_host',
          path,
          requester,
        });
      }
    } else if (state === null) {
      response = new Response(null, { status: 503 });
    } else {
      try {
        response = await answerHTTPRequest(state, request, requester, (label) => {
          rpc = label;
        });
      } catch {
        response = new Response(null, { status: 503 });
      }
    }

    options.printRequest(
      formatRequestLine(request, rpc, response.status, performance.now() - startedAt),
    );

    return response;
  };

  const server = Bun.serve({
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

  const hosts = new Set([
    new URL(origin).host,
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    ...options.allowedHosts,
  ]);

  holder.hosts = hosts;

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

  holder.ready = {
    hosts,
    origins: new Set([origin, local, `http://localhost:${port}`]),
    ctx: {
      caller: options.caller,
      build: options.build,
      origin,
      resource: `${origin}/mcp`,
      store,
      approvals: new ApprovalState(APPROVAL_WINDOW_SECONDS * 1000, () => clock.now()),
      enrollments: new EnrollmentState(() => clock.now()),
      security,
      clock,
    },
  };

  return {
    url: local,
    listening: formatBindURL(options.host, port),
    origin,
    stop: async () => {
      await server.stop(true);
      await store.close();

      security.drain();
    },
  };
}

// A probe from a Host other than the server's own is refused like any other
// request; `ready` is whether the authorization server's database is open.
function answerProbeRequest(
  request: Request,
  path: string,
  hosts: ReadonlySet<string>,
  ready: boolean,
): Response {
  const host = request.headers.get('host');

  if (host === null || !hosts.has(host)) {
    return new Response(null, { status: 403 });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  const isReady = path === '/healthz' || ready;

  // an empty body, so a probe learns nothing about the fleet.
  return new Response(null, { status: isReady ? 200 : 503 });
}

// MCP answers at `/` as well as at `/mcp`, for a client configured with the
// bare origin. Both are the one resource `<origin>/mcp`.
const MCP_PATHS: ReadonlySet<string> = new Set(['/mcp', '/']);

// The browser pages: passkey sign-in, passkey enrollment, and consent.
const PAGE_PATHS: ReadonlySet<string> = new Set(['/login', '/enroll', '/consent']);

// The better-auth routes a connector calls directly.
const PASSED_THROUGH: ReadonlySet<string> = new Set(['POST /oauth2/revoke']);

// Both paths serve the protected resource metadata for `<origin>/mcp`.
const RESOURCE_METADATA: ReadonlySet<string> = new Set([
  'GET /.well-known/oauth-protected-resource',
  'GET /.well-known/oauth-protected-resource/mcp',
]);

// `requester` is where the request came from, for its security events.
// `onRPC` receives an accepted MCP request's JSON-RPC method and tool, for
// its request line.
async function answerHTTPRequest(
  state: ServerState,
  request: Request,
  requester: Requester,
  onRPC: (label: RPCLabel | null) => void,
): Promise<Response> {
  const ctx = state.ctx;

  const url = new URL(request.url);

  const host = request.headers.get('host');

  if (host === null || !state.hosts.has(host)) {
    ctx.security.record({
      kind: 'authorize_invalid',
      outcome: 'rejected',
      reason: 'bad_host',
      path: url.pathname,
      requester,
    });

    return new Response(null, { status: 403 });
  }

  const route = `${request.method} ${url.pathname}`;
  const requestOrigin = request.headers.get('origin');
  const isForeignOrigin = requestOrigin !== null && !state.origins.has(requestOrigin);

  if (PASSED_THROUGH.has(route)) {
    return ctx.store.auth.handler(toPublicRequest(ctx, request, url));
  }

  if (route === 'GET /.well-known/oauth-authorization-server' || RESOURCE_METADATA.has(route)) {
    return answerMetadataRequest(ctx, request, url);
  }

  if (route === 'GET /oauth2/authorize') {
    return answerAuthorizeRequest(ctx, url, requester);
  }

  if (route === 'POST /oauth2/token') {
    return answerTokenRequest(ctx, request, url, requester);
  }

  if (route === 'GET /error') {
    return buildPageResponse(400, { message: pickErrorMessage(url.searchParams.get('error')) });
  }

  const isPage = PAGE_PATHS.has(url.pathname);

  if (isPage && request.method === 'POST' && (requestOrigin === null || isForeignOrigin)) {
    ctx.security.record({
      kind: 'authorize_invalid',
      outcome: 'rejected',
      reason: 'bad_origin',
      path: url.pathname,
      requester,
    });

    return buildPageResponse(403, { message: 'The form came from an unexpected origin.' });
  }

  if (isPage && (request.method === 'GET' || request.method === 'POST')) {
    const body = request.method === 'POST' ? await request.text() : '';

    if (url.pathname === '/login') {
      return answerLoginRequest(ctx, request.method, url, body, requester);
    }

    if (url.pathname === '/enroll') {
      return answerEnrollRequest(ctx, request.method, url, body, requester);
    }

    return answerConsentRequest(ctx, {
      method: request.method,
      url,
      cookie: request.headers.get('cookie'),
      body,
      requester,
    });
  }

  if (MCP_PATHS.has(url.pathname)) {
    if (isForeignOrigin) {
      ctx.security.record({
        kind: 'authorize_invalid',
        outcome: 'rejected',
        reason: 'bad_origin',
        path: url.pathname,
        requester,
      });

      return new Response(null, { status: 403 });
    }

    if (request.method !== 'POST') {
      return new Response(null, { status: 405, headers: { allow: 'POST' } });
    }

    const body = await request.text();

    onRPC(findRPCLabel(body));

    return answerMCPRequest(ctx, {
      authorization: request.headers.get('authorization'),
      protocolVersion: request.headers.get('mcp-protocol-version'),
      body,
      path: url.pathname,
      requester,
    });
  }

  return new Response(null, { status: 404 });
}

// better-auth builds every URL it returns from its base URL, so a request
// that reached the local address is handed over as if it came to the public
// origin.
function toPublicRequest(ctx: HTTPServerContext, request: Request, url: URL): Request {
  return new Request(`${ctx.origin}${url.pathname}${url.search}`, request);
}

// The metadata advertises only what atc's clients can use: public clients
// with no client authentication, no introspection endpoint, and Bearer
// tokens alone, so nothing about DPoP.
async function answerMetadataRequest(
  ctx: HTTPServerContext,
  request: Request,
  url: URL,
): Promise<Response> {
  const response = await ctx.store.auth.handler(toPublicRequest(ctx, request, url));
  const metadata: unknown = await response.json();

  if (!isRecord(metadata)) {
    return new Response(null, { status: 503 });
  }

  const advertised = Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) => !key.startsWith('introspection_') && !key.startsWith('dpop_'),
    ),
  );

  if (RESOURCE_METADATA.has(`${request.method} ${url.pathname}`)) {
    return Response.json(advertised, { status: response.status });
  }

  return Response.json({
    ...advertised,
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
  });
}

// better-auth binds a code exchange's tokens to the owner session that approved it.
async function answerTokenRequest(
  ctx: HTTPServerContext,
  request: Request,
  url: URL,
  requester: Requester,
): Promise<Response> {
  // the body is read once here, so the refusal's event can name its client.
  const body = await request.text();

  const sent = new Request(request.url, { method: request.method, headers: request.headers, body });

  const response = await ctx.store.auth.handler(toPublicRequest(ctx, sent, url));

  if (!response.ok) {
    await recordRefusedExchange(ctx, {
      contentType: request.headers.get('content-type'),
      body,
      response,
      path: url.pathname,
      requester,
    });

    return response;
  }

  const attached = await ctx.store.db
    .selectFrom('oauthAccessToken')
    .select('sessionId')
    .where('sessionId', 'is not', null)
    .union(
      ctx.store.db
        .selectFrom('oauthRefreshToken')
        .select('sessionId')
        .where('sessionId', 'is not', null),
    )
    .execute();

  const sessionIDs = attached.flatMap((row) => (row.sessionId === null ? [] : [row.sessionId]));

  // detached tokens outlive their session, so a session's end never ends a grant.
  await ctx.store.db
    .updateTable('oauthAccessToken')
    .set({ sessionId: null })
    .where('sessionId', 'is not', null)
    .execute();

  await ctx.store.db
    .updateTable('oauthRefreshToken')
    .set({ sessionId: null })
    .where('sessionId', 'is not', null)
    .execute();

  // the session's one authorization is done.
  await ctx.store.db
    .deleteFrom('session')
    .where((eb) =>
      eb.or([
        eb('expiresAt', '<', new Date().toISOString()),
        ...(sessionIDs.length === 0 ? [] : [eb('id', 'in', sessionIDs)]),
      ]),
    )
    .execute();

  return response;
}

function findRPCLabel(body: string): RPCLabel | null {
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

// An IPv6 address takes the brackets a URL puts around it.
function formatBindURL(host: string, port: number): string {
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  return `http://${bracketed}:${port}`;
}
