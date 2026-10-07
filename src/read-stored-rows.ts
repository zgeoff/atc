import type { DaemonClient } from './client/daemon-client';
import { isRecord } from './shared/report';

export interface StoredRow {
  readonly id: string;
  readonly name: string;
  readonly exited: boolean;
}

/**
 * Reads the fleet rows a daemon has stored, exited ones included.
 */
export async function readStoredRows(
  client: Pick<DaemonClient, 'sendRequest'>,
): Promise<StoredRow[]> {
  const listed = await client.sendRequest('fleet.list');

  const fleet = listed['fleet'];

  if (!Array.isArray(fleet)) {
    return [];
  }

  return fleet
    .filter((entry) => isRecord(entry))
    .map((entry) => ({
      id: String(entry['sessionID']),
      name: String(entry['name']),
      exited: entry['exited'] === true,
    }));
}
