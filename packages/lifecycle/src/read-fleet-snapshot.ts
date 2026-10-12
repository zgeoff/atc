import { DaemonClient } from '@atc/protocol/client/daemon-client';
import { readSessionEnv } from '@atc/protocol/read-session-env';
import { readStoredRows } from '@atc/store/snapshot/read-stored-rows';
import type { StoredRow } from '@atc/store/snapshot/read-stored-rows';

const SNAPSHOT_DEADLINE_MS = 3000;

/**
 * Reads the stored fleet rows from the daemon at this socket, handshaking
 * with this client's build, or null when it does not answer in time. The
 * restart takes this before it stops the daemon, so the rows keep their
 * original exit status.
 */
export async function readFleetSnapshot(
  socketPath: string,
  build: string,
): Promise<StoredRow[] | null> {
  let client: DaemonClient;

  try {
    client = await DaemonClient.open(socketPath);
  } catch {
    return null;
  }

  const expiry = setTimeout(() => {
    client.stop();
  }, SNAPSHOT_DEADLINE_MS);

  try {
    await client.sendHello(build, { session: readSessionEnv(process.env).sessionID });

    return await readStoredRows(client);
  } catch {
    return null;
  } finally {
    clearTimeout(expiry);

    client.stop();
  }
}
