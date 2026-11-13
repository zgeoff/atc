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
import type { HTTPServerContext, VerifiedAccess } from '../auth/types';
import { buildPrincipalCaller } from '../tools/build-principal-caller';
import { createMCPServer } from '../tools/create-mcp-server';

// The adapter verified the request's bearer token before it got here.
export async function answerMCPRequest(
  ctx: HTTPServerContext,
  request: Request,
  access: VerifiedAccess,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }

  const metadataURL = `${ctx.origin}${GATEWAY_PATHS.machine.mcpResourceMetadata}`;
  const authorization = request.headers.get('authorization') ?? '';
  const token = /^Bearer (?<token>\S+)$/iu.exec(authorization)?.groups?.['token'] ?? '';

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
