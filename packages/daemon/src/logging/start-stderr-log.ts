import { systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import { configure, dispose } from '@logtape/logtape';
import { createStderrSink } from './create-stderr-sink';

const STDERR_FD = 2;

export interface StderrLog {
  readonly stop: () => Promise<void>;
}

// LogTape's own diagnostics would otherwise reach the descriptor, which must carry only atc's
// lines.
export async function startStderrLog(
  fd: number = STDERR_FD,
  clock: Clock = systemClock,
  batchLines?: number,
): Promise<StderrLog> {
  await configure({
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

async function stopLog(clock: Clock): Promise<void> {
  const timedOut = Promise.withResolvers<void>();
  const cancelTimeout = clock.schedule(timedOut.resolve, STOP_TIMEOUT_MS);

  await Promise.race([disposeLog(), timedOut.promise]);

  cancelTimeout();
}

async function disposeLog(): Promise<void> {
  // A sink that fails to close loses only its last lines, which must not
  // keep the process from exiting.
  try {
    await dispose();
  } catch {}
}
