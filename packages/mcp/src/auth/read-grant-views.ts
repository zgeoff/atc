import { parseJSONStrings } from '@atc/core';
import { GRANT_SCOPES } from '@atcx/contract';
import type { GrantScope } from '@atcx/contract';
import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from './mcp-auth-schema';

export interface GrantView {
  readonly grantID: string;
  readonly clientID: string;
  readonly clientName: string;
  readonly scopes: readonly GrantScope[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export async function readGrantViews(db: Kysely<MCPAuthSchema>): Promise<readonly GrantView[]> {
  const rows = await db
    .selectFrom('oauthRefreshToken')
    .leftJoin('oauthClient', 'oauthClient.clientId', 'oauthRefreshToken.clientId')
    .leftJoin('atc_grant_use', 'atc_grant_use.grant_id', 'oauthRefreshToken.authorizationCodeId')
    .select([
      'oauthRefreshToken.authorizationCodeId',
      'oauthRefreshToken.clientId',
      'oauthRefreshToken.scopes',
      'oauthRefreshToken.createdAt',
      'oauthClient.name',
      'atc_grant_use.last_used_at',
    ])
    .where('oauthRefreshToken.revoked', 'is', null)
    .where('oauthRefreshToken.expiresAt', '>', new Date().toISOString())
    .where('oauthRefreshToken.authorizationCodeId', 'is not', null)
    .orderBy('oauthRefreshToken.createdAt')
    .execute();

  return rows.map((row) => {
    const scopes = parseJSONStrings(row.scopes) ?? [];

    return {
      grantID: row.authorizationCodeId ?? '',
      clientID: row.clientId,
      clientName: row.name ?? '',
      scopes: GRANT_SCOPES.filter((scope) => scopes.includes(scope)),
      createdAt: row.createdAt,
      lastUsedAt: row.last_used_at,
    };
  });
}
