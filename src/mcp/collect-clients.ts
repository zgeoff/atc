import type { Kysely } from 'kysely';
import { collectJSONStrings } from './collect-json-strings';
import type { MCPAuthSchema } from './types';

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
    redirectURIs: collectJSONStrings(row.redirectUris),
    createdAt: row.createdAt,
  }));
}
