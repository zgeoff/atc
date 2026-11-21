import { configure, dispose } from '@logtape/logtape';
import type { Clock } from '@zgeoff/std';
import { systemClock } from '@zgeoff/std';
import { createStderrSink } from './create-stderr-sink';

const STDERR_FD = 2;

export interface StderrLog {
  readonly stop: () => Promise<void>;
}

// LogTape's own diagnostics would otherwise reach the descriptor, which must carry only atc's
// lines.
export async function startStderrLog(
  fd: number = STDERR_FD,
  clock: Pick<Clock, 'now' | 'schedule'> = systemClock,
  batchLines?: number,
): Promise<StderrLog> {
  // The daemon is the only owner of LogTape's process-wide configuration, so a configuration
  // left by an earlier owner in the same process is replaced, never a reason to refuse to start.
  await configure({
    reset: true,
    sinks: { stderr: createStderrSink(fd, batchLines) },
    loggers: [
      { category: ['atc'], sinks: ['stderr'], lowestLevel: 'info' },
      { category: ['logtape', 'meta'], sinks: [] },
    ],
  });

  // LogTape refuses a second disposal while the first runs, so every stop
  // waits on the first.
  let stopping: Promise<void> | null = null;

  return {
    stop: () => {
      stopping ??= stopLog(clock);

      return stopping;
    },
  };
}

// An unread stderr pipe blocks writes with no end, so stopping gives up after one second.
const STOP_TIMEOUT_MS = 1000;

async function stopLog(clock: Pick<Clock, 'now' | 'schedule'>): Promise<void> {
  const timedOut = Promise.withResolvers<void>();
  const cancelTimeout = clock.schedule(timedOut.resolve, STOP_TIMEOUT_MS);

  await Promise.race([disposeLog(), timedOut.promise]);

  cancelTimeout();
}

async function disposeLog(): Promise<void> {
  try {
    await dispose();
  } catch {}
}
