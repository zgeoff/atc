import { isAPIError } from 'better-auth/api';
import { GRANT_SCOPES } from '../shared/grant-scope';
import type { GrantScope } from '../shared/grant-scope';
import { normalizeClientName } from '../shared/normalize-client-name';
import { isRecord } from '../shared/report';
import { answerRPCRequest } from './answer-rpc-request';
import { buildPrincipalCaller } from './build-principal-caller';
import { deriveTokenHash } from './derive-token-hash';
import { findClientName } from './find-client-name';
import { isSupportedProtocolVersion } from './is-supported-protocol-version';
import type { HTTPServerContext } from './types';

interface MCPHTTPRequest {
  readonly authorization: string | null;
  readonly protocolVersion: string | null;
  readonly body: string;
}

/**
 * Answers `POST /mcp`: one JSON-RPC message from a client holding an access
 * token. Every request checks its token against the authorization server's
 * database, so a revoked grant loses access at once, and a token bound to any
 * other resource is refused. A tool call outside the token's scopes is a 403
 * that names the missing scope. A message the client sends is always from the
 * client's own name, and every request acts as the client's id, so the
 * daemon limits it to the targets that principal may use.
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

  const access = await verifyAccessToken(ctx, token);

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
    caller: buildPrincipalCaller(ctx.caller, access.clientID),
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
    const id = isRecord(message) ? (message['id'] ?? null) : null;
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
  readonly clientID: string;
  readonly clientName: string;
  readonly scopes: readonly GrantScope[];
}

// An inactive, unknown, or revoked token, one bound to another resource, or
// one without a client id verifies to null. Verifying stamps when the token's grant was last used.
async function verifyAccessToken(
  ctx: HTTPServerContext,
  token: string,
): Promise<VerifiedAccess | null> {
  let payload: unknown;

  try {
    payload = await ctx.store.auth.api.verifyMCPAccessToken({ body: { token } });
  } catch (error) {
    if (isAPIError(error)) {
      return null;
    }

    throw error;
  }

  if (!isRecord(payload) || ![payload['aud']].flat().includes(ctx.resource)) {
    return null;
  }

  const granted = typeof payload['scope'] === 'string' ? payload['scope'].split(' ') : [];
  const clientID = typeof payload['client_id'] === 'string' ? payload['client_id'] : '';

  if (clientID === '') {
    return null;
  }

  await upsertGrantUse(ctx, token);

  const storedName = await findClientName(ctx.store.db, clientID);

  return {
    clientID,
    clientName: normalizeClientName(storedName, 'remote'),
    scopes: GRANT_SCOPES.filter((scope) => granted.includes(scope)),
  };
}

async function upsertGrantUse(ctx: HTTPServerContext, token: string): Promise<void> {
  const row = await ctx.store.db
    .selectFrom('oauthAccessToken')
    .select('authorizationCodeId')
    .where('token', '=', deriveTokenHash(token))
    .executeTakeFirst();

  const grantID = row?.authorizationCodeId ?? null;

  if (grantID === null) {
    return;
  }

  const now = new Date().toISOString();

  await ctx.store.db
    .insertInto('atc_grant_use')
    .values({ grant_id: grantID, last_used_at: now })
    .onConflict((conflict) => conflict.column('grant_id').doUpdateSet({ last_used_at: now }))
    .execute();
}

function buildRPCError(status: number, id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status });
}
