import { deriveTokenHash } from '../auth/derive-token-hash';
import { normalizeClientName } from '../auth/normalize-client-name';
import { readClientName } from '../auth/read-client-name';
import type { HTTPServerContext, VerifiedAccess } from '../auth/types';
import { readTokenAccess } from './read-token-access';

// Verifying stamps when the token's grant was last used.
export async function verifyAccessToken(
  ctx: HTTPServerContext,
  token: string,
): Promise<VerifiedAccess | null> {
  const access = await readTokenAccess(ctx, token);

  if (access === null) {
    return null;
  }

  await upsertGrantUse(ctx, token);

  const storedName = await readClientName(ctx.store.db, access.clientID);

  return {
    clientID: access.clientID,
    clientName: normalizeClientName(storedName, 'remote'),
    scopes: access.scopes,
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
