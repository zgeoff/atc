import type { DaemonClient } from './client/daemon-client';
import type { RestartFailedRow } from './parse-restart-result';
import { isRecord } from './shared/report';

interface FleetVerdict {
  // The rows the daemon stored, exited ones included.
  readonly total: number;
  readonly failed: readonly RestartFailedRow[];
}

// The rows that are not restored yet, and whether waiting longer can still
// change that.
interface FailedRows {
  readonly failed: readonly RestartFailedRow[];
  readonly pending: boolean;
}

interface StoredRow {
  readonly id: string;
  readonly name: string;
  readonly exited: boolean;
}

/**
 * Restores the stored fleet on a daemon and waits for every stored row to
 * show up. The call joins a restore the daemon already started by itself. A
 * row that is not exited must be listed with a live terminal before the deadline
 * passes (`timeoutSeconds` when set, else the rows that are not exited times the restore boot cap, plus 30 s), and an exited row must be listed. A stored row that is not listed
 * failed to restore, and a listed row that is still without a live terminal
 * at the deadline failed to revive.
 */
export async function verifyRestoredFleet(
  client: Pick<DaemonClient, 'sendRequest'>,
  timeoutSeconds: number | null,
): Promise<FleetVerdict> {
  const stored = await readStoredRows(client);
  const restored = await tryRestore(client);

  const deadline = Date.now() + pickDeadlineMs(stored, timeoutSeconds);

  let found = await collectFailedRows(client, stored, restored);

  while (found.pending && Date.now() < deadline) {
    await Bun.sleep(250);

    found = await collectFailedRows(client, stored, restored);
  }

  return { total: stored.length, failed: found.failed };
}

function pickDeadlineMs(stored: readonly StoredRow[], timeoutSeconds: number | null): number {
  if (timeoutSeconds !== null) {
    return timeoutSeconds * 1000;
  }

  const cap = Number(process.env['ATC_RESTORE_BOOT_TIMEOUT_MS']);
  const bootMs = Number.isFinite(cap) && cap >= 0 ? cap : 15_000;

  return stored.filter((row) => !row.exited).length * bootMs + 30_000;
}

async function readStoredRows(client: Pick<DaemonClient, 'sendRequest'>): Promise<StoredRow[]> {
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

async function tryRestore(client: Pick<DaemonClient, 'sendRequest'>): Promise<boolean> {
  try {
    await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

    return true;
  } catch {
    return false;
  }
}

async function collectFailedRows(
  client: Pick<DaemonClient, 'sendRequest'>,
  stored: readonly StoredRow[],
  restored: boolean,
): Promise<FailedRows> {
  const listed = await client.sendRequest('session.list');

  const sessions = Array.isArray(listed['sessions']) ? listed['sessions'].filter(isRecord) : [];

  const byID = new Map(sessions.map((session) => [String(session['id']), session]));

  const failed: RestartFailedRow[] = [];
  let pending = false;

  for (const row of stored) {
    const session = byID.get(row.id);

    if (session === undefined) {
      failed.push({ name: row.name, id: row.id, reason: 'not listed after the restore' });

      // A finished restore lists every row it registers, so a row still
      // missing never appears; after a failed restore it may yet.
      pending ||= !restored;
    } else if (!row.exited && !(session['alive'] === true && session['kind'] === 'pty')) {
      failed.push({
        name: row.name,
        id: row.id,
        reason: `listed in state ${String(session['state'])} without a terminal: ${String(session['lastMsg'])}`,
      });

      pending = true;
    }
  }

  return { failed, pending };
}
