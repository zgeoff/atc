import { mkdirSync } from 'node:fs';
import type { RestartResult } from '@atcx/contract';
import type { LifecycleHost } from '../boot/types';
import { claimDaemonLock } from '../daemon-files/claim-daemon-lock';
import { buildRestartFailure } from './build-restart-failure';
import { formatRestartReport } from './format-restart-report';
import { readRestartResult } from './read-restart-result';
import { removeRestartResult } from './remove-restart-result';
import { restartDaemon } from './restart-daemon';
import type { RestartOptions } from './restart-daemon';
import { writeRestartEvent } from './write-restart-event';
import { writeRestartResult } from './write-restart-result';

export async function runDaemonRestartWorker(
  host: LifecycleHost,
  options: RestartOptions,
): Promise<number> {
  console.log(JSON.stringify({ workerPID: process.pid }));

  const restartsDir = host.paths.restartsDir;

  mkdirSync(restartsDir, { recursive: true });

  const lock = await claimDaemonLock(host.paths.restartLockFile, 0);

  let result: RestartResult;

  if (lock === null) {
    result = await waitForRestartInFlight(host, options.runID);
  } else {
    try {
      removeRestartResult(restartsDir);

      result = await restartDaemon(host, options).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);

        return buildRestartFailure(options.runID, reason);
      });

      writeRestartResult(restartsDir, result);

      const event = await writeRestartEvent(host, result);

      if (event.kind === 'no_daemon') {
        console.log('no daemon answered, so the restart is not on the event feed');
      }

      if (event.kind === 'failed') {
        console.log(`cannot put the restart on the event feed: ${event.reason}`);
      }
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

const JOIN_WAIT_MS = 15 * 60_000;

async function waitForRestartInFlight(host: LifecycleHost, runID: string): Promise<RestartResult> {
  console.log('another restart is in flight; this run joins it and reports its result');

  const held = await claimDaemonLock(host.paths.restartLockFile, JOIN_WAIT_MS);

  if (held === null) {
    return buildRestartFailure(runID, 'timed out waiting for the restart in flight to finish');
  }

  const finished = readRestartResult(host.paths.restartsDir);

  held.dispose();

  return finished === null
    ? buildRestartFailure(runID, 'the restart in flight left no result')
    : { ...finished, runID };
}
