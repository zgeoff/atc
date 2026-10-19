import { isRecord } from '@atc/core';
import type { DaemonClient } from '@atc/protocol/client';

export interface StoredRow {
  readonly id: string;
  readonly name: string;
  readonly exited: boolean;
}

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
