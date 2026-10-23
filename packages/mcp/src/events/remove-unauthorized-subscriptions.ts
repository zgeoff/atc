import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from '../auth/mcp-auth-schema';
import { createSubscriptionStore } from './create-subscription-store';
import { probeReadAccess } from './probe-read-access';

// A subscription delivers what the client could read, so it ends with the
// client's last live grant that holds read, rather than at its refreshBefore.
export async function removeUnauthorizedSubscriptions(
  db: Kysely<MCPAuthSchema>,
  clientID: string,
  now: number,
): Promise<void> {
  const reads = await probeReadAccess(db, clientID, now);

  if (reads) {
    return;
  }

  await createSubscriptionStore(db).endForClient(clientID);

  await db.deleteFrom('atc_event_callback').where('client_id', '=', clientID).execute();
}
