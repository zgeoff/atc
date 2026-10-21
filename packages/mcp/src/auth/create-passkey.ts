import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from './mcp-auth-schema';

interface NewPasskey {
  // The hash of the enrollment token the passkey was enrolled with.
  readonly tokenHash: string;

  // The credential id and its COSE public key, both base64url.
  readonly id: string;
  readonly publicKey: string;
  readonly counter: number;
  readonly transports: readonly string[];

  // Epoch milliseconds.
  readonly now: number;
}

export function createPasskey(db: Kysely<MCPAuthSchema>, passkey: NewPasskey): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    // spending the token in the same transaction as the insert lets one token
    // enroll one passkey.
    const spent = await trx
      .deleteFrom('atc_enrollment_token')
      .where('token_hash', '=', passkey.tokenHash)
      .where('expires_at', '>', new Date(passkey.now).toISOString())
      .executeTakeFirst();

    if (spent.numDeletedRows === 0n) {
      return false;
    }

    await trx
      .insertInto('atc_passkey')
      .values({
        id: passkey.id,
        public_key: passkey.publicKey,
        counter: passkey.counter,
        transports: JSON.stringify(passkey.transports),
        created_at: new Date(passkey.now).toISOString(),
        last_used_at: null,
      })
      .execute();

    return true;
  });
}
