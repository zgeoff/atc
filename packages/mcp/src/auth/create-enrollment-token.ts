import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { deriveTokenHash } from './derive-token-hash';
import type { MCPAuthSchema } from './mcp-auth-schema';

// How long an enrollment token stays usable after the host command mints it.
const ENROLLMENT_TOKEN_MS = 15 * 60_000;

export async function createEnrollmentToken(
  db: Kysely<MCPAuthSchema>,
  now: number,
): Promise<{ readonly token: string; readonly expiresAt: number }> {
  const token = `atc-enroll-${randomBytes(32).toString('base64url')}`;
  const expiresAt = now + ENROLLMENT_TOKEN_MS;

  await db
    .insertInto('atc_enrollment_token')
    .values({
      token_hash: deriveTokenHash(token),
      created_at: new Date(now).toISOString(),
      expires_at: new Date(expiresAt).toISOString(),
    })
    .execute();

  return { token, expiresAt };
}
