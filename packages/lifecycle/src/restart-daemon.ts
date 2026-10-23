import { resolve } from 'node:path';
import { loadListenerTokens } from '@atc/config';
import { readStoredFleetFile } from '@atc/store';
import type { RestartResult } from '@atcx/contract';
import { buildRestartFailure } from './build-restart-failure';
import { formatRestartPreflight } from './format-restart-preflight';
import type { LifecycleHost } from './lifecycle-host';
import { readDaemonProcess } from './read-daemon-process';
import { readFleetSnapshot } from './read-fleet-snapshot';
import { readOwnDaemonProcess } from './read-own-daemon-process';
import { readRestartPlan } from './read-restart-plan';
import { restartDaemonProcess } from './restart-daemon-process';
import { startReplacementDaemon } from './start-replacement-daemon';
import { verifyRestoredFleet } from './verify-restored-fleet';
import { waitForReplacement } from './wait-for-replacement';

export interface RestartOptions {
  readonly runID: string;
  readonly callerSession: string | null;
  readonly listen: string | null;
  readonly tokenFile: string | null;
  readonly timeoutSeconds: number | null;
}

const START_WAIT_MS = 30_000;

export async function restartDaemon(
  host: LifecycleHost,
  options: RestartOptions,
): Promise<RestartResult> {
  const plan = await readRestartPlan(host, options.callerSession);

  const clientBuild = host.invocation.readBuild();

  for (const line of formatRestartPreflight(plan)) {
    console.log(line);
  }

  const interrupted = (plan.sessions ?? [])
    .filter((session) => session.state === 'running')
    .map((session) => ({ name: session.name, id: session.id }));

  // Taken while the old daemon still runs, so a row that the restore marks
  // exited is not mistaken for one that was archived before. A daemon this
  // build cannot speak to is read from its database instead.
  const snapshot =
    (plan.answer?.kind === 'ok' && plan.socketPath !== null
      ? await readFleetSnapshot(plan.socketPath, clientBuild, host.clock)
      : null) ?? readStoredFleetFile(host.paths.dbFile);

  if (snapshot === null) {
    console.log(
      'cannot read the stored fleet before the stop: the report checks the rows the new daemon lists, and a row it marks exited counts as restored',
    );
  }

  const buildFailure = (error: string): RestartResult =>
    buildRestartFailure(options.runID, error, interrupted);

  let expectedBuild: string | null = null;

  if (plan.replacement.kind === 'unit') {
    if (options.listen !== null || options.tokenFile !== null) {
      console.log('--listen and --token-file are ignored: the unit decides how the daemon starts');
    }

    try {
      await restartDaemonProcess({ pid: plan.replacement.pid, unit: plan.replacement.unit }, host);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      return buildFailure(reason);
    }
  } else {
    expectedBuild = clientBuild;

    const old =
      plan.pid === null ? readOwnDaemonProcess() : readDaemonProcess(plan.pid, host.procRoot);

    if (plan.pid !== null && !old.fromProc) {
      console.log(
        'cannot read /proc for the daemon: the replacement starts with this restart’s environment and without the old listener flags',
      );
    }

    const listen = options.listen ?? old.flags.listen;
    const tokenFile = options.tokenFile ?? old.flags.tokenFile;

    if ((listen === null) !== (tokenFile === null)) {
      return buildFailure('--listen and --token-file go together; the daemon was left running');
    }

    if (listen !== null && tokenFile !== null) {
      const loaded = loadListenerTokens(resolve(old.cwd ?? process.cwd(), tokenFile));

      if (!loaded.ok) {
        return buildFailure(`${loaded.reason}; the daemon was left running`);
      }
    }

    if (plan.pid !== null) {
      const stopped = await restartDaemonProcess({ pid: plan.pid, unit: null }, host);

      const stoppedLine =
        stopped.kind === 'stopped' && stopped.killed
          ? `the daemon (pid ${plan.pid}) ignored SIGTERM for 10 s, so it was killed with SIGKILL`
          : `stopped the daemon (pid ${plan.pid})`;

      console.log(stoppedLine);
    }

    startReplacementDaemon(host.invocation.argv, old, {
      listen: options.listen,
      tokenFile: options.tokenFile,
    });
  }

  const replacement = await waitForReplacement(host, plan.pid, expectedBuild, START_WAIT_MS);

  if (!replacement.ok) {
    return buildFailure(replacement.reason);
  }

  try {
    console.log(`daemon pid ${replacement.pid} is up (${replacement.build}); restoring the fleet`);

    const verdict = await verifyRestoredFleet(
      replacement.client,
      options.timeoutSeconds,
      snapshot,
      host.clock,
      host.restoreBootTimeoutMs,
    );

    return {
      runID: options.runID,
      code: verdict.failed.length === 0 ? 0 : 1,
      pid: replacement.pid,
      build: replacement.build,
      listenPort: replacement.listenPort,
      restored: verdict.total - verdict.failed.length,
      total: verdict.total,
      failed: [...verdict.failed],
      interrupted,
      error: null,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return {
      ...buildFailure(`the fleet could not be verified: ${reason}`),
      pid: replacement.pid,
      build: replacement.build,
      listenPort: replacement.listenPort,
    };
  } finally {
    replacement.client.stop();
  }
}
