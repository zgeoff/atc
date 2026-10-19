import { systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import { configure, dispose } from '@logtape/logtape';
import { createStderrSink } from './create-stderr-sink';

const STDERR_FD = 2;

export interface StderrLog {
  readonly stop: () => Promise<void>;
}

// LogTape's own diagnostics write nowhere, so the descriptor carries only atc's lines. `stop` gives
// up after a second, so an unread pipe holds an exiting process back no longer, and every call
// waits on the one disposal, so a second shutdown path exits no sooner.
export async function startStderrLog(
  fd: number = STDERR_FD,
  clock: Clock = systemClock,
): Promise<StderrLog> {
  await configure({
    sinks: { stderr: createStderrSink(fd) },
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

// How long a stopping log waits for the lines it still holds to be written,
// so an unread stderr delays the exit no longer.
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
