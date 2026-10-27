import { isRecord } from '@atc/core';
import { isAPIError } from 'better-auth/api';
import { deriveTokenHash } from '../auth/derive-token-hash';
import { normalizeClientName } from '../auth/normalize-client-name';
import { readClientName } from '../auth/read-client-name';
import type { HTTPServerContext, VerifiedAccess } from '../auth/types';
import { GRANT_SCOPES } from '../tools/grant-scope';

// An inactive, unknown, or revoked token, one bound to another resource, or
// one without a client id verifies to null. Verifying stamps when the token's grant was last used.
export async function verifyAccessToken(
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
