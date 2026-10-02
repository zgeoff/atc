import { MAX_LINE } from '../protocol/protocol';
import { answerApprovalRequest } from './answer-approval-request';
import { answerAuthorizeRequest } from './answer-authorize-request';
import { answerMCPRequest } from './answer-mcp-request';
import { answerRegisterRequest } from './answer-register-request';
import { answerTokenRequest } from './answer-token-request';
import { AuthorizationState } from './authorization-state';
import { buildAuthorizationServerMetadata } from './build-authorization-server-metadata';
import { buildPageResponse } from './build-page-response';
import { buildProtectedResourceMetadata } from './build-protected-resource-metadata';
import { normalizePublicURL } from './normalize-public-url';
import { OAuthClientResolver } from './oauth-client-resolver';
import type { FleetCaller, HTTPServerContext } from './types';

interface MCPHTTPServerOptions {
  readonly caller: FleetCaller;
  readonly build: string;

  // 0 binds a free port.
  readonly port: number;

  // The origin clients reach the server at; absent means the local address.
  readonly publicURL: string | null;

  // Further Host header values to accept, for a proxy that rewrites Host.
  readonly allowedHosts: readonly string[];

  // Hosts whose client id URLs may be fetched as client metadata documents.
  readonly metadataHosts: readonly string[];
  readonly printApproval: (line: string) => void;

  // How long an approval waits for its code, and how long a code stays exchangeable.
  readonly pendingMs?: number;
  readonly codeMs?: number;
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
 * Serves atc's MCP tools over streamable HTTP at `/mcp`, behind atc's own
 * single-user OAuth 2.1 authorization server. It listens on 127.0.0.1 only;
 * exposing it is the operator's job. Requests with an unknown Host header are
 * refused, so a DNS rebinding page cannot reach it through a browser.
 */
export function startMCPHTTPServer(options: MCPHTTPServerOptions): MCPHTTPServer {
  const holder: {
    ctx: HTTPServerContext | null;
    hosts: ReadonlySet<string>;
    origins: ReadonlySet<string>;
  } = {
    ctx: null,
    hosts: new Set(),
    origins: new Set(),
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port,

    // A long poll holds a request open for up to 30 seconds without a byte.
    idleTimeout: 60,
    maxRequestBodySize: MAX_LINE,
    fetch: async (request) => {
      if (holder.ctx === null) {
        return new Response(null, { status: 503 });
      }

      try {
        const answered = await answerHTTPRequest(holder.ctx, holder.hosts, holder.origins, {
          method: request.method,
          url: request.url,
          host: request.headers.get('host'),
          origin: request.headers.get('origin'),
          authorization: request.headers.get('authorization'),
          protocolVersion: request.headers.get('mcp-protocol-version'),
          readBody: () => request.text(),
        });

        return answered;
      } catch {
        return new Response(null, { status: 503 });
      }
    },
  });

  const port = server.port ?? options.port;
  const local = `http://127.0.0.1:${port}`;
  const origin = options.publicURL === null ? local : normalizePublicURL(options.publicURL);

  holder.hosts = new Set([
    new URL(origin).host,
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    ...options.allowedHosts,
  ]);

  holder.origins = new Set([origin, local, `http://localhost:${port}`]);

  holder.ctx = {
    caller: options.caller,
    build: options.build,
    origin,
    resource: `${origin}/mcp`,
    authorization: new AuthorizationState(
      { pendingMs: options.pendingMs ?? 600_000, codeMs: options.codeMs ?? 60_000 },
      () => Date.now(),
    ),
    clients: new OAuthClientResolver(options.caller, options.metadataHosts, () => Date.now()),
    printApproval: options.printApproval,
  };

  return {
    url: local,
    origin,
    stop: async () => {
      await server.stop(true);
    },
  };
}

// The parts of an HTTP request the routes read.
interface IncomingRequest {
  readonly method: string;
  readonly url: string;
  readonly host: string | null;
  readonly origin: string | null;
  readonly authorization: string | null;
  readonly protocolVersion: string | null;
  readonly readBody: () => Promise<string>;
}

async function answerHTTPRequest(
  ctx: HTTPServerContext,
  hosts: ReadonlySet<string>,
  origins: ReadonlySet<string>,
  request: IncomingRequest,
): Promise<Response> {
  const host = request.host;

  if (host === null || !hosts.has(host)) {
    return new Response(null, { status: 403 });
  }

  const url = new URL(request.url);

  const requestOrigin = request.origin;
  const route = `${request.method} ${url.pathname}`;

  if (route === 'GET /.well-known/oauth-authorization-server') {
    return Response.json(buildAuthorizationServerMetadata(ctx.origin));
  }

  if (
    route === 'GET /.well-known/oauth-protected-resource' ||
    route === 'GET /.well-known/oauth-protected-resource/mcp'
  ) {
    return Response.json(buildProtectedResourceMetadata(ctx.origin));
  }

  if (route === 'GET /authorize') {
    const page = await answerAuthorizeRequest(ctx, request.url);

    return page;
  }

  if (route === 'POST /authorize') {
    if (requestOrigin === null || !origins.has(requestOrigin)) {
      return buildPageResponse(403, { message: 'The approval came from an unexpected origin.' });
    }

    const body = await request.readBody();

    return answerApprovalRequest(ctx, body);
  }

  if (route === 'POST /token') {
    const body = await request.readBody();
    const token = await answerTokenRequest(ctx, body);

    return token;
  }

  if (route === 'POST /register') {
    const body = await request.readBody();
    const registered = await answerRegisterRequest(ctx, body);

    return registered;
  }

  if (url.pathname === '/mcp') {
    if (requestOrigin !== null && !origins.has(requestOrigin)) {
      return new Response(null, { status: 403 });
    }

    if (request.method !== 'POST') {
      return new Response(null, { status: 405, headers: { allow: 'POST' } });
    }

    const body = await request.readBody();

    const answered = await answerMCPRequest(ctx, {
      authorization: request.authorization,
      protocolVersion: request.protocolVersion,
      body,
    });

    return answered;
  }

  return new Response(null, { status: 404 });
}
