import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from '../auth/mcp-auth-schema';
import { probeReadAccess } from './probe-read-access';

// A subscription delivers what the client could read, so it ends with the
// client's last live grant that holds read, rather than at its refreshBefore.
export async function removeUnauthorizedSubscriptions(
  db: Kysely<MCPAuthSchema>,
  clientID: string,
): Promise<void> {
  const reads = await probeReadAccess(db, clientID);

  if (reads) {
    return;
  }

  await db.deleteFrom('atc_event_subscription').where('client_id', '=', clientID).execute();
  await db.deleteFrom('atc_event_callback').where('client_id', '=', clientID).execute();
}
