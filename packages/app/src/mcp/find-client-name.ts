import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from './mcp-auth-schema';

/**
 * The name a client was added under, or null for an unknown client id or a
 * client added without one.
 */
export async function findClientName(
  db: Kysely<MCPAuthSchema>,
  clientID: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('oauthClient')
    .select('name')
    .where('clientId', '=', clientID)
    .executeTakeFirst();

  return row?.name ?? null;
}
