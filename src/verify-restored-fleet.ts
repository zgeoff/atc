import type { DaemonClient } from './client/daemon-client';
import type { RestartFailedRow } from './parse-restart-result';
import type { StoredRow } from './read-stored-rows';
import { readStoredRows } from './read-stored-rows';
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

const UNSIZED_READ_MS = 30_000;

/**
 * Restores the stored fleet on a daemon and waits for every stored row to
 * show up. `snapshot` holds the rows read from the old daemon before it
 * stopped, with their original exit status; without one, the new daemon's
 * rows are read instead. The call joins a restore the daemon already started by itself. A
 * row that is not exited must be listed with a live terminal before the deadline
 * passes (`timeoutSeconds` when set, else the rows that are not exited times the restore boot cap, plus 30 s), and an exited row must be listed. A stored row that is not listed
 * failed to restore, and a listed row that is still without a live terminal
 * at the deadline failed to revive. The deadline counts from the call, and
 * every request to the daemon is held to it.
 */
export async function verifyRestoredFleet(
  client: Pick<DaemonClient, 'sendRequest'>,
  timeoutSeconds: number | null,
  snapshot: readonly StoredRow[] | null,
): Promise<FleetVerdict> {
  const startedAt = Date.now();

  // Without a snapshot the rows come from the new daemon, and its count is
  // not known until they are read, so that read gets the fixed allowance.
  const read =
    snapshot === null
      ? await sendBounded(
          () => readStoredRows(client),
          startedAt + (timeoutSeconds === null ? UNSIZED_READ_MS : timeoutSeconds * 1000),
        )
      : null;

  const stored = snapshot ?? read ?? [];
  const deadline = startedAt + pickDeadlineMs(stored, timeoutSeconds);

  const restored = await tryRestore(client, deadline);
  let found = await sendBounded(() => collectFailedRows(client, stored, restored), deadline);

  while (found.pending && Date.now() < deadline) {
    await Bun.sleep(250);

    found = await sendBounded(() => collectFailedRows(client, stored, restored), deadline);
  }

  return { total: stored.length, failed: found.failed };
}

/**
 * Runs a request and rejects once the deadline passes, so a daemon that
 * stops answering cannot hold the restart, and its lock, open.
 */
async function sendBounded<T>(send: () => Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        reject(new Error('the new daemon stopped answering before the restore deadline'));
      },
      Math.max(0, deadline - Date.now()),
    );
  });

  try {
    return await Promise.race([send(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function pickDeadlineMs(stored: readonly StoredRow[], timeoutSeconds: number | null): number {
  if (timeoutSeconds !== null) {
    return timeoutSeconds * 1000;
  }

  const cap = Number(process.env['ATC_RESTORE_BOOT_TIMEOUT_MS']);
  const bootMs = Number.isFinite(cap) && cap >= 0 ? cap : 15_000;

  return stored.filter((row) => !row.exited).length * bootMs + 30_000;
}

async function tryRestore(
  client: Pick<DaemonClient, 'sendRequest'>,
  deadline: number,
): Promise<boolean> {
  try {
    await sendBounded(() => client.sendRequest('fleet.restore', { cols: 80, rows: 24 }), deadline);

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

  const byAgentID = new Map(
    sessions
      .filter((session) => typeof session['agentSessionID'] === 'string')
      .map((session) => [String(session['agentSessionID']), session]),
  );

  const failed: RestartFailedRow[] = [];
  let pending = false;

  for (const row of stored) {
    const session =
      byID.get(row.id) ??
      (row.agentSessionID === null ? undefined : byAgentID.get(row.agentSessionID));

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
