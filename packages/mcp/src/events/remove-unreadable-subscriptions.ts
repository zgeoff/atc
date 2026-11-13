import type { Kysely } from 'kysely';
import { createSubscriptionStore } from './create-subscription-store';
import type { EventSchema } from './event-schema';

// A subscription ends with its client's last grant that holds read. A revoke
// names only its grant, so every client with a subscription or a verified
// callback is checked again.
export async function removeUnreadableSubscriptions(
  db: Kysely<EventSchema>,
  probeRead: (clientID: string) => Promise<boolean>,
): Promise<void> {
  const clients = await db
    .selectFrom('atc_event_subscription')
    .select('client_id')
    .union(db.selectFrom('atc_event_callback').select('client_id'))
    .execute();

  for (const client of clients) {
    const clientID = client.client_id;

    const isReadable = await probeRead(clientID);

    if (isReadable) {
      continue;
    }

    await createSubscriptionStore(db).endForClient(clientID);

    await db.deleteFrom('atc_event_callback').where('client_id', '=', clientID).execute();
  }
}
