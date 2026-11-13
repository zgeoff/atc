import type { Kysely } from 'kysely';
import type { EventSchema } from './event-schema';

interface CallbackVerification {
  readonly clientID: string;
  readonly url: string;
  readonly now: number;
}

export async function writeCallbackVerifiedAt(
  db: Kysely<EventSchema>,
  verification: CallbackVerification,
): Promise<void> {
  const verifiedAt = new Date(verification.now).toISOString();

  await db
    .insertInto('atc_event_callback')
    .values({ client_id: verification.clientID, url: verification.url, verified_at: verifiedAt })
    .onConflict((conflict) =>
      conflict.columns(['client_id', 'url']).doUpdateSet({ verified_at: verifiedAt }),
    )
    .execute();
}
