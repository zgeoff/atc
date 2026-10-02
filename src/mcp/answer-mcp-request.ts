import { DaemonError } from '../protocol/daemon-error';
import { GRANT_SCOPES } from '../shared/grant-scope';
import type { GrantScope } from '../shared/grant-scope';
import { answerRPCRequest } from './answer-rpc-request';
import { deriveTokenHash } from './derive-token-hash';
import { isSupportedProtocolVersion } from './is-supported-protocol-version';
import type { HTTPServerContext } from './types';

interface MCPHTTPRequest {
  readonly authorization: string | null;
  readonly protocolVersion: string | null;
  readonly body: string;
}

/**
 * Answers `POST /mcp`: one JSON-RPC message from a client holding a grant.
 * Every request checks its bearer token with the daemon, so a revoked grant
 * loses access at once. A tool call outside the grant's scopes is a 403 that
 * names the missing scope.
 */
export async function answerMCPRequest(
  ctx: HTTPServerContext,
  request: MCPHTTPRequest,
): Promise<Response> {
  if (request.protocolVersion !== null && !isSupportedProtocolVersion(request.protocolVersion)) {
    return new Response(null, { status: 400 });
  }

  const metadataURL = `${ctx.origin}/.well-known/oauth-protected-resource/mcp`;
  const token = /^Bearer (?<token>\S+)$/i.exec(request.authorization ?? '')?.groups?.['token'];

  if (token === undefined) {
    return new Response(null, {
      status: 401,
      headers: { 'www-authenticate': `Bearer resource_metadata="${metadataURL}"` },
    });
  }

  const access = await verifyToken(ctx, token);

  if (access === null) {
    return new Response(null, {
      status: 401,
      headers: {
        'www-authenticate': `Bearer error="invalid_token", resource_metadata="${metadataURL}"`,
      },
    });
  }

  let message: unknown;

  try {
    message = JSON.parse(request.body);
  } catch {
    return buildRPCError(400, null, -32_700, 'parse error');
  }

  if (Array.isArray(message)) {
    return buildRPCError(400, null, -32_600, 'atc does not accept JSON-RPC batches');
  }

  const outcome = await answerRPCRequest(message, {
    caller: ctx.caller,
    build: ctx.build,
    toolContext: { callerSessionID: null, sender: { kind: 'fixed', name: access.clientName } },
    scopes: access.scopes,
  });

  if (outcome.kind === 'reply') {
    return Response.json(outcome.body);
  }

  if (outcome.kind === 'accepted') {
    return new Response(null, { status: 202 });
  }

  if (outcome.kind === 'forbidden') {
    const id =
      typeof message === 'object' && message !== null && 'id' in message ? message.id : null;

    const response = buildRPCError(403, id, -32_001, `this grant lacks the ${outcome.scope} scope`);

    response.headers.set(
      'www-authenticate',
      `Bearer error="insufficient_scope", scope="${outcome.scope}", resource_metadata="${metadataURL}"`,
    );

    return response;
  }

  return buildRPCError(400, null, -32_600, 'invalid request');
}

interface VerifiedAccess {
  readonly clientName: string;
  readonly scopes: readonly GrantScope[];
}

async function verifyToken(ctx: HTTPServerContext, token: string): Promise<VerifiedAccess | null> {
  try {
    const verified = await ctx.caller.sendRequest('grant.verify', {
      accessHash: deriveTokenHash(token),
      resource: ctx.resource,
    });

    const granted = Array.isArray(verified['scopes']) ? verified['scopes'] : [];
    const clientName = verified['clientName'];

    return {
      clientName: typeof clientName === 'string' ? clientName : 'remote',
      scopes: GRANT_SCOPES.filter((scope) => granted.includes(scope)),
    };
  } catch (error) {
    if (error instanceof DaemonError && error.code === 'unauthorized') {
      return null;
    }

    throw error;
  }
}

function buildRPCError(status: number, id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status });
}
