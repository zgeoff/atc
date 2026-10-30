import { isRecord } from '@atc/core';
import { GATEWAY_PATHS } from '@atcx/contract';
import {
  OAuthError,
  OAuthErrorCode,
  WebStandardStreamableHTTPServerTransport,
  bearerAuthChallengeResponse,
  isLegacyRequest,
} from '@modelcontextprotocol/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { BearerReason, HTTPServerContext, Requester } from '../auth/types';
import { buildPrincipalCaller } from '../tools/build-principal-caller';
import { createMCPServer } from '../tools/create-mcp-server';
import { verifyAccessToken } from './verify-access-token';

// `requester` is where the request came from, for its security events.
export async function answerMCPRequest(
  ctx: HTTPServerContext,
  request: Request,
  requester: Requester,
): Promise<Response> {
  const path = new URL(request.url).pathname;

  const metadataURL = `${ctx.origin}${GATEWAY_PATHS.machine.mcpResourceMetadata}`;
  const authorization = request.headers.get('authorization');
  const token = /^Bearer (?<token>\S+)$/iu.exec(authorization ?? '')?.groups?.['token'];

  if (token === undefined) {
    // a request with no header at all is a client discovering the
    // authorization server, so only a header that holds no bearer token is
    // recorded.
    if (authorization !== null) {
      recordRefusedBearer(ctx, path, requester, 'malformed');
    }

    return new Response(null, {
      status: 401,
      headers: { 'www-authenticate': `Bearer resource_metadata="${metadataURL}"` },
    });
  }

  const access = await verifyAccessToken(ctx, token);

  if (access === null) {
    recordRefusedBearer(ctx, path, requester, 'invalid_token');

    return new Response(null, {
      status: 401,
      headers: {
        'www-authenticate': `Bearer error="invalid_token", resource_metadata="${metadataURL}"`,
      },
    });
  }

  const authInfo: AuthInfo = {
    token,
    clientId: access.clientID,
    scopes: [...access.scopes],
    resourceMetadataUrl: metadataURL,
  };

  const isLegacy = await isLegacyRequest(request);

  if (!isLegacy) {
    const method = await readRPCMethod(request);

    // The SDK checks the scope of a tool call itself, and knows nothing of
    // the event methods, each of which needs read.
    if (!access.scopes.includes('read') && method?.startsWith('events/') === true) {
      return bearerAuthChallengeResponse(
        new OAuthError(OAuthErrorCode.InsufficientScope, 'Insufficient scope'),
        { requiredScopes: ['read'], resourceMetadataUrl: metadataURL },
      );
    }

    return ctx.modern.answer(request, access, authInfo);
  }

  // Each request gets a server of its own, so the tools it lists and the
  // scopes it checks are the token's.
  const server = createMCPServer({
    caller: buildPrincipalCaller(ctx.caller, { id: access.clientID, name: access.clientName }),
    build: ctx.build,
    toolContext: { callerSessionID: null },
    scopes: access.scopes,
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);

  try {
    return await transport.handleRequest(request, { authInfo });
  } finally {
    await server.close();
  }
}

// The event holds neither the header nor the token.
function recordRefusedBearer(
  ctx: HTTPServerContext,
  path: string,
  requester: Requester,
  reason: BearerReason,
): void {
  ctx.security.record({ kind: 'bearer', outcome: 'rejected', reason, path, requester });
}

// The JSON-RPC method of a request, read from a copy of its body, so the
// handler still reads the body itself.
async function readRPCMethod(request: Request): Promise<string | null> {
  const body = await request.clone().text();

  let message: unknown;

  try {
    message = JSON.parse(body);
  } catch {
    return null;
  }

  return isRecord(message) && typeof message['method'] === 'string' ? message['method'] : null;
}
