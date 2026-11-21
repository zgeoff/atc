import { readStoredRows } from '@atc/store';
import type { StoredRow } from '@atc/store';
import type { Clock } from '@zgeoff/std';
import { tryOpenDaemon } from '../boot/try-open-daemon';

const SNAPSHOT_DEADLINE_MS = 3000;

export async function readFleetSnapshot(
  socketPath: string,
  build: string,
  clock: Pick<Clock, 'now' | 'schedule'>,
): Promise<StoredRow[] | null> {
  const probe = await tryOpenDaemon(
    [socketPath],
    { build, deadline: clock.now() + SNAPSHOT_DEADLINE_MS, clock },
    (client) => readStoredRows(client).catch(() => null),
  );

  return probe?.kind === 'ok' ? probe.value : null;
}
