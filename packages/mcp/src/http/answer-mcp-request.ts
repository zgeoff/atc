import { isRecord } from '@atc/core';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { isAPIError } from 'better-auth/api';
import { deriveTokenHash } from '../auth/derive-token-hash';
import { normalizeClientName } from '../auth/normalize-client-name';
import { readClientName } from '../auth/read-client-name';
import type { BearerReason, HTTPServerContext, Requester } from '../auth/types';
import { buildPrincipalCaller } from '../tools/build-principal-caller';
import { createMCPServer } from '../tools/create-mcp-server';
import { GRANT_SCOPES } from '../tools/grant-scope';
import type { GrantScope } from '../tools/grant-scope';

// `requester` is where the request came from, for its security events.
export async function answerMCPRequest(
  ctx: HTTPServerContext,
  request: Request,
  requester: Requester,
): Promise<Response> {
  const path = new URL(request.url).pathname;

  const metadataURL = `${ctx.origin}/.well-known/oauth-protected-resource/mcp`;
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
    return await transport.handleRequest(request, {
      authInfo: {
        token,
        clientId: access.clientID,
        scopes: [...access.scopes],
        resourceMetadataUrl: metadataURL,
      },
    });
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

  const storedName = await readClientName(ctx.store.db, clientID);

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

  const now = new Date(ctx.clock.now()).toISOString();

  await ctx.store.db
    .insertInto('atc_grant_use')
    .values({ grant_id: grantID, last_used_at: now })
    .onConflict((conflict) => conflict.column('grant_id').doUpdateSet({ last_used_at: now }))
    .execute();
}
