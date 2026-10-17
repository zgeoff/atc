import { systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import { configure, dispose } from '@logtape/logtape';
import { createStderrSink } from './create-stderr-sink';

const STDERR_FD = 2;

// How long a stopping log waits for the lines it still holds to be written,
// so an unread stderr delays the exit no longer.
const STOP_TIMEOUT_MS = 1000;

/**
 * The process's LogTape configuration, which `stop` disposes of.
 */
export interface StderrLog {
  readonly stop: () => Promise<void>;
}

/**
 * Configures LogTape for the process, once, so that every logger under the
 * `atc` category writes plain lines to stderr, or to the given descriptor,
 * through a sink that never blocks the event loop. LogTape's own
 * diagnostics write nowhere, so the descriptor carries only atc's lines.
 *
 * `stop` disposes of the configuration, which writes the lines the sink
 * still holds and the count of any it dropped, and resolves once that is
 * done or a second has passed on the given clock, whichever comes first:
 * every line reaches a reader that keeps reading, and an unread pipe holds
 * a process that exits after it back no longer than the second. Every call
 * waits on the one disposal, so a second shutdown path that calls it while
 * the first runs exits no sooner.
 */
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
