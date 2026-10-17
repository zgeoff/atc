import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from './mcp-auth-schema';

export async function resetPasskeys(db: Kysely<MCPAuthSchema>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('atc_passkey').execute();
    await trx.deleteFrom('atc_enrollment_token').execute();
    await trx.deleteFrom('session').execute();
  });
}
