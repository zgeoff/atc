import { MAX_LINE } from '../protocol/protocol';
import { isRecord } from '../shared/report';
import { answerAuthorizeRequest } from './answer-authorize-request';
import { answerConsentRequest } from './answer-consent-request';
import { answerLoginRequest } from './answer-login-request';
import { answerMCPRequest } from './answer-mcp-request';
import { ApprovalState } from './approval-state';
import { buildPageResponse } from './build-page-response';
import { isLoopbackHost } from './is-loopback-host';
import { normalizePublicURL } from './normalize-public-url';
import { openMCPAuth } from './open-mcp-auth';
import type { FleetCaller, HTTPServerContext } from './types';

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

  // The authorization server's SQLite database.
  readonly dbPath: string;
  readonly printApproval: (line: string) => void;

  // How long a rotated refresh token still answers with its successor.
  readonly refreshReuseSeconds?: number;
}

/**
 * A running MCP HTTP server.
 */
export interface MCPHTTPServer {
  // The local address the server listens on.
  readonly url: string;

  // The public origin: the OAuth issuer.
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

/**
 * Serves atc's MCP tools over streamable HTTP at `/mcp`, with better-auth as
 * the OAuth 2.1 authorization server in the same process. Only the routes a
 * connector and the operator's browser need reach better-auth; every other
 * path is a 404. A request whose Host header is not the server's own is
 * refused, so a DNS rebinding page cannot reach it through a browser, and a
 * browser form post from any other origin is refused too.
 */
export async function startMCPHTTPServer(options: MCPHTTPServerOptions): Promise<MCPHTTPServer> {
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

  const holder: { ready: ServerState | null } = { ready: null };

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,

    // A long poll holds a request open for up to 30 seconds without a byte.
    idleTimeout: 60,
    maxRequestBodySize: MAX_LINE,
    fetch: async (request) => {
      const state = holder.ready;

      if (state === null) {
        return new Response(null, { status: 503 });
      }

      try {
        const answered = await answerHTTPRequest(state, request);

        return answered;
      } catch {
        return new Response(null, { status: 503 });
      }
    },
  });

  const port = server.port ?? options.port;
  const local = `http://127.0.0.1:${port}`;
  const origin = publicOrigin ?? local;
  let store: HTTPServerContext['store'];

  try {
    store = await openMCPAuth({
      dbPath: options.dbPath,
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
    hosts: new Set([
      new URL(origin).host,
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      ...options.allowedHosts,
    ]),
    origins: new Set([origin, local, `http://localhost:${port}`]),
    ctx: {
      caller: options.caller,
      build: options.build,
      origin,
      resource: `${origin}/mcp`,
      store,
      approvals: new ApprovalState(600_000, () => Date.now()),
      printApproval: options.printApproval,
    },
  };

  return {
    url: local,
    origin,
    stop: async () => {
      await server.stop(true);
      await store.close();
    },
  };
}

interface ServerState {
  readonly hosts: ReadonlySet<string>;
  readonly origins: ReadonlySet<string>;
  readonly ctx: HTTPServerContext;
}

// The better-auth routes a connector calls directly.
const PASSED_THROUGH: ReadonlySet<string> = new Set([
  'GET /.well-known/oauth-protected-resource',
  'GET /.well-known/oauth-protected-resource/mcp',
  'POST /oauth2/revoke',
]);

async function answerHTTPRequest(state: ServerState, request: Request): Promise<Response> {
  const host = request.headers.get('host');

  if (host === null || !state.hosts.has(host)) {
    return new Response(null, { status: 403 });
  }

  const ctx = state.ctx;

  const url = new URL(request.url);

  const route = `${request.method} ${url.pathname}`;
  const requestOrigin = request.headers.get('origin');
  const isForeignOrigin = requestOrigin !== null && !state.origins.has(requestOrigin);

  if (PASSED_THROUGH.has(route)) {
    return ctx.store.auth.handler(toPublicRequest(ctx, request, url));
  }

  if (route === 'GET /.well-known/oauth-authorization-server') {
    return answerMetadataRequest(ctx, request, url);
  }

  if (route === 'GET /oauth2/authorize') {
    return answerAuthorizeRequest(ctx, url);
  }

  if (route === 'POST /oauth2/token') {
    return answerTokenRequest(ctx, request, url);
  }

  if (route === 'GET /error') {
    const reason = url.searchParams.get('error_description') ?? url.searchParams.get('error');

    return buildPageResponse(400, {
      message: `atc refused this authorization request: ${reason ?? 'unknown error'}.`,
    });
  }

  const isPage = url.pathname === '/login' || url.pathname === '/consent';

  if (isPage && request.method === 'POST' && (requestOrigin === null || isForeignOrigin)) {
    return buildPageResponse(403, { message: 'The form came from an unexpected origin.' });
  }

  if (isPage && (request.method === 'GET' || request.method === 'POST')) {
    const body = request.method === 'POST' ? await request.text() : '';

    return url.pathname === '/login'
      ? answerLoginRequest(ctx, request.method, url, body)
      : answerConsentRequest(ctx, {
          method: request.method,
          url,
          cookie: request.headers.get('cookie'),
          body,
        });
  }

  if (url.pathname === '/mcp') {
    if (isForeignOrigin) {
      return new Response(null, { status: 403 });
    }

    if (request.method !== 'POST') {
      return new Response(null, { status: 405, headers: { allow: 'POST' } });
    }

    return answerMCPRequest(ctx, {
      authorization: request.headers.get('authorization'),
      protocolVersion: request.headers.get('mcp-protocol-version'),
      body: await request.text(),
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
// with no client authentication, and no introspection endpoint.
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
    Object.entries(metadata).filter(([key]) => !key.startsWith('introspection_')),
  );

  return Response.json({
    ...advertised,
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
  });
}

// A code exchange binds its tokens to the owner session that approved it;
// once issued, every token is detached from its session, so a session's end
// never ends the grant.
async function answerTokenRequest(
  ctx: HTTPServerContext,
  request: Request,
  url: URL,
): Promise<Response> {
  const response = await ctx.store.auth.handler(toPublicRequest(ctx, request, url));

  if (response.ok) {
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

    await ctx.store.db
      .deleteFrom('session')
      .where('expiresAt', '<', new Date().toISOString())
      .execute();
  }

  return response;
}
