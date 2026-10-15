import { parseJSONStrings } from '@atc/core';
import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from './mcp-auth-schema';

/**
 * A client added with `atc clients add`.
 */
export interface ClientView {
  readonly clientID: string;
  readonly name: string;
  readonly redirectURIs: readonly string[];
  readonly createdAt: string | null;
}

/**
 * Every client the authorization server knows, oldest first.
 */
export async function collectClients(db: Kysely<MCPAuthSchema>): Promise<readonly ClientView[]> {
  const rows = await db
    .selectFrom('oauthClient')
    .select(['clientId', 'name', 'redirectUris', 'createdAt'])
    .orderBy('createdAt')
    .execute();

  return rows.map((row) => ({
    clientID: row.clientId,
    name: row.name ?? '',
    redirectURIs: parseJSONStrings(row.redirectUris) ?? [],
    createdAt: row.createdAt,
  }));
}
