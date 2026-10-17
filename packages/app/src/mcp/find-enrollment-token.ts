import type { Kysely } from 'kysely';
import { deriveTokenHash } from './derive-token-hash';
import type { MCPAuthSchema } from './mcp-auth-schema';

export async function findEnrollmentToken(
  db: Kysely<MCPAuthSchema>,
  token: string,
  now: number,
): Promise<string | null> {
  const row = await db
    .selectFrom('atc_enrollment_token')
    .select('token_hash')
    .where('token_hash', '=', deriveTokenHash(token))
    .where('expires_at', '>', new Date(now).toISOString())
    .executeTakeFirst();

  return row?.token_hash ?? null;
}
