import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from './mcp-auth-schema';

export interface PasskeyView {
  readonly id: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export async function collectPasskeys(db: Kysely<MCPAuthSchema>): Promise<readonly PasskeyView[]> {
  const rows = await db
    .selectFrom('atc_passkey')
    .select(['id', 'created_at', 'last_used_at'])
    .orderBy('created_at')
    .orderBy('id')
    .execute();

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}
