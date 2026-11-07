import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from './mcp-auth-schema';

export async function removeOwnerSession(
  db: Kysely<MCPAuthSchema>,
  sessionID: string,
): Promise<void> {
  await db.deleteFrom('session').where('id', '=', sessionID).execute();
}
