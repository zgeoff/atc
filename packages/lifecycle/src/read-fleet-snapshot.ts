import type { Clock } from '@atc/core';
import { readStoredRows } from '@atc/store';
import type { StoredRow } from '@atc/store';
import { tryOpenDaemon } from './try-open-daemon';

const SNAPSHOT_DEADLINE_MS = 3000;

// a restart takes this before it stops the daemon, so the rows keep their
// original exit status.
export async function readFleetSnapshot(
  socketPath: string,
  build: string,
  clock: Clock,
): Promise<StoredRow[] | null> {
  const probe = await tryOpenDaemon(
    [socketPath],
    { build, deadline: clock.now() + SNAPSHOT_DEADLINE_MS, clock },
    (client) => readStoredRows(client).catch(() => null),
  );

  return probe?.kind === 'ok' ? probe.value : null;
}
