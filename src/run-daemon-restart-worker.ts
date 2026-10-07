import { mkdirSync } from 'node:fs';
import { buildRestartFailure } from './build-restart-failure';
import { formatRestartReport } from './format-restart-report';
import type { RestartResult } from './parse-restart-result';
import { readRestartResult } from './read-restart-result';
import { restartDaemon } from './restart-daemon';
import type { RestartOptions } from './restart-daemon';
import { claimDaemonLock } from './shared/claim-daemon-lock';
import { restartLockFile, restartsDir } from './shared/config';
import { writeRestartResult } from './write-restart-result';

// How long a restart that finds another in flight waits for it to finish.
const JOIN_WAIT_MS = 15 * 60_000;

/**
 * Runs one restart as the handoff worker: it takes the restart lock and
 * restarts the daemon, or, when another restart holds the lock, waits for
 * that restart to finish and reports its result without touching the
 * daemon. Prints each step to stdout, which the caller follows in the run
 * log, and ends the log with the result record. Resolves the exit code.
 */
export async function runDaemonRestartWorker(options: RestartOptions): Promise<number> {
  console.log(`worker pid ${process.pid}`);

  mkdirSync(restartsDir, { recursive: true });

  const lock = await claimDaemonLock(restartLockFile, 0);

  let result: RestartResult;

  if (lock === null) {
    result = await waitForRestartInFlight(options.runID);
  } else {
    try {
      result = await restartDaemon(options).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);

        return buildRestartFailure(options.runID, reason);
      });

      writeRestartResult(result);
    } finally {
      lock.dispose();
    }
  }

  for (const line of formatRestartReport(result)) {
    console.log(line);
  }

  console.log(JSON.stringify(result));

  return result.code;
}

async function waitForRestartInFlight(runID: string): Promise<RestartResult> {
  console.log('another restart is in flight; this run joins it and reports its result');

  const held = await claimDaemonLock(restartLockFile, JOIN_WAIT_MS);

  if (held === null) {
    return buildRestartFailure(runID, 'timed out waiting for the restart in flight to finish');
  }

  const finished = readRestartResult();

  held.dispose();

  return finished === null
    ? buildRestartFailure(runID, 'the restart in flight left no result')
    : { ...finished, runID };
}
