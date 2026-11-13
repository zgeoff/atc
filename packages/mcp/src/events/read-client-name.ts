import type { Kysely } from 'kysely';
import type { EventSchema } from './event-schema';

export async function readClientName(
  db: Kysely<EventSchema>,
  clientID: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('oauthClient')
    .select('name')
    .where('clientId', '=', clientID)
    .executeTakeFirst();

  return row?.name ?? null;
}
