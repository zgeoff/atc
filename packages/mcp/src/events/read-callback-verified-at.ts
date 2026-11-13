import type { Kysely } from 'kysely';
import type { EventSchema } from './event-schema';

export async function readCallbackVerifiedAt(
  db: Kysely<EventSchema>,
  clientID: string,
  url: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('atc_event_callback')
    .select('verified_at')
    .where('client_id', '=', clientID)
    .where('url', '=', url)
    .executeTakeFirst();

  return row?.verified_at ?? null;
}
