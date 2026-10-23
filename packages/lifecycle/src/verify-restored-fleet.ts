import { isRecord } from '@atc/core';
import type { Clock } from '@atc/core';
import type { RestartFailedRow } from '@atc/protocol';
import type { DaemonClient } from '@atc/protocol/client';
import type { StoredRow } from '@atc/store';
import { readStoredRows } from '@atc/store';

interface FleetVerdict {
  // The rows the daemon stored, exited ones included.
  readonly total: number;
  readonly failed: readonly RestartFailedRow[];
}

const UNSIZED_READ_MS = 30_000;

interface VerifyRestoredFleetOptions {
  readonly timeoutSeconds: number | null;
  readonly snapshot: readonly StoredRow[] | null;
  readonly clock: Clock;
  readonly restoreBootTimeoutMs: number;
}

export async function verifyRestoredFleet(
  client: Pick<DaemonClient, 'sendRequest'>,
  options: VerifyRestoredFleetOptions,
): Promise<FleetVerdict> {
  const clock = options.clock;
  const timeoutSeconds = options.timeoutSeconds;
  const startedAt = clock.now();

  // Without a snapshot the rows come from the new daemon, and its count is
  // not known until they are read, so that read gets the fixed allowance.
  const read =
    options.snapshot === null
      ? await sendBounded(
          () => readStoredRows(client),
          startedAt + (timeoutSeconds === null ? UNSIZED_READ_MS : timeoutSeconds * 1000),
          clock,
        )
      : null;

  const stored = options.snapshot ?? read ?? [];
  const deadline = startedAt + pickDeadlineMs(stored, timeoutSeconds, options.restoreBootTimeoutMs);

  const restored = await tryRestore(client, deadline, clock);
  const agents = await tryReadAgentIDs(client, deadline, clock);

  const outcome = { stored, restored, agents };

  let found = await sendBounded(() => readFailedRows(client, outcome), deadline, clock);

  while (found.pending && clock.now() < deadline) {
    await new Promise<void>((resolve) => {
      clock.schedule(resolve, Math.min(250, deadline - clock.now()));
    });

    const polled = await tryCollectFailedRows(client, outcome, deadline, clock);

    if (polled === null) {
      break;
    }

    found = polled;
  }

  return { total: stored.length, failed: found.failed };
}

// the deadline rejects so a daemon that stops answering cannot hold the
// restart, and its lock, open.
async function sendBounded<T>(send: () => Promise<T>, deadline: number, clock: Clock): Promise<T> {
  let stopTimer: (() => void) | undefined;

  const expired = new Promise<never>((_resolve, reject) => {
    stopTimer = clock.schedule(
      () => {
        reject(new Error('the new daemon stopped answering before the restore deadline'));
      },
      Math.max(0, deadline - clock.now()),
    );
  });

  try {
    return await Promise.race([send(), expired]);
  } finally {
    stopTimer?.();
  }
}

function pickDeadlineMs(
  stored: readonly StoredRow[],
  timeoutSeconds: number | null,
  restoreBootTimeoutMs: number,
): number {
  if (timeoutSeconds !== null) {
    return timeoutSeconds * 1000;
  }

  return stored.filter((row) => !row.exited).length * restoreBootTimeoutMs + 30_000;
}

async function tryRestore(
  client: Pick<DaemonClient, 'sendRequest'>,
  deadline: number,
  clock: Clock,
): Promise<boolean> {
  try {
    await sendBounded(
      () => client.sendRequest('fleet.restore', { cols: 80, rows: 24 }),
      deadline,
      clock,
    );

    return true;
  } catch {
    return false;
  }
}

// How long the agent list may take, so a daemon that withholds it still
// leaves the rest of the deadline to list the rows.
const AGENTS_READ_MS = 5000;

// null keeps every row one that waiting can still revive.
async function tryReadAgentIDs(
  client: Pick<DaemonClient, 'sendRequest'>,
  deadline: number,
  clock: Clock,
): Promise<ReadonlySet<string> | null> {
  try {
    const listed = await sendBounded(
      () => client.sendRequest('agents.list'),
      Math.min(deadline, clock.now() + AGENTS_READ_MS),
      clock,
    );

    const agents = listed['agents'];

    if (!Array.isArray(agents)) {
      return null;
    }

    return new Set(agents.filter((agent) => isRecord(agent)).map((agent) => String(agent['id'])));
  } catch {
    return null;
  }
}

// The rows that are not restored yet, and whether waiting longer can still
// change that.
interface FailedRows {
  readonly failed: readonly RestartFailedRow[];
  readonly pending: boolean;
}

interface RestoreOutcome {
  readonly stored: readonly StoredRow[];
  readonly restored: boolean;
  readonly agents: ReadonlySet<string> | null;
}

async function readFailedRows(
  client: Pick<DaemonClient, 'sendRequest'>,
  outcome: RestoreOutcome,
): Promise<FailedRows> {
  const listed = await client.sendRequest('session.list');

  const sessions = Array.isArray(listed['sessions']) ? listed['sessions'].filter(isRecord) : [];

  const byID = new Map(sessions.map((session) => [String(session['id']), session]));

  const failed: RestartFailedRow[] = [];
  let pending = false;

  for (const row of outcome.stored) {
    const session = byID.get(row.id);

    if (session === undefined) {
      failed.push({ name: row.name, id: row.id, reason: 'not listed after the restore' });

      // A finished restore lists every row it registers, so a row still
      // missing never appears; after a failed restore it may yet.
      pending ||= !outcome.restored;
    } else if (
      !row.exited &&
      !(session['alive'] === true && session['kind'] === 'pty') &&
      typeof session['restoreRefusal'] === 'string'
    ) {
      // A refusal no later try of the restore lifts waits on an action of
      // the operator's own, so no wait revives the row.
      failed.push({
        name: row.name,
        id: row.id,
        reason: `restore refused (${session['restoreRefusal']}): ${String(session['lastMsg'])}`,
      });
    } else if (!row.exited && !(session['alive'] === true && session['kind'] === 'pty')) {
      failed.push({
        name: row.name,
        id: row.id,
        reason: `listed in state ${String(session['state'])} without a terminal: ${String(session['lastMsg'])}`,
      });

      // A row whose agent is gone from the config never gets a terminal,
      // while one whose agent is listed but not installed yet still may.
      pending ||= outcome.agents === null || outcome.agents.has(String(session['agent']));
    }
  }

  return { failed, pending };
}

async function tryCollectFailedRows(
  client: Pick<DaemonClient, 'sendRequest'>,
  outcome: RestoreOutcome,
  deadline: number,
  clock: Clock,
): Promise<FailedRows | null> {
  let stopTimer: (() => void) | undefined;

  const expired = new Promise<null>((resolve) => {
    stopTimer = clock.schedule(
      () => {
        resolve(null);
      },
      Math.max(0, deadline - clock.now()),
    );
  });

  try {
    return await Promise.race([readFailedRows(client, outcome), expired]);
  } finally {
    stopTimer?.();
  }
}
