import { DaemonClient } from './client/daemon-client';
import { readStoredRows } from './read-stored-rows';
import type { StoredRow } from './read-stored-rows';
import { getBuild } from './shared/get-build';

const SNAPSHOT_DEADLINE_MS = 3000;

/**
 * Reads the stored fleet rows from the daemon at this socket, or null when
 * it does not answer in time. The restart takes this before it stops the
 * daemon, so the rows keep their original exit status.
 */
export async function readFleetSnapshot(socketPath: string): Promise<StoredRow[] | null> {
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
    await client.sendHello(getBuild());

    return await readStoredRows(client);
  } catch {
    return null;
  } finally {
    clearTimeout(expiry);

    client.stop();
  }
}
