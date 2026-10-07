import { buildOwnDaemonProcess } from './build-own-daemon-process';
import { buildRestartFailure } from './build-restart-failure';
import { collectRestartPlan } from './collect-restart-plan';
import { formatRestartPreflight } from './format-restart-preflight';
import type { RestartResult } from './parse-restart-result';
import { readDaemonProcess } from './read-daemon-process';
import { runSystemctl } from './run-systemctl';
import { getBuild } from './shared/get-build';
import { startReplacementDaemon } from './start-replacement-daemon';
import { stopDaemonProcess } from './stop-daemon-process';
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

/**
 * Stops the running daemon, starts exactly one in its place, restores the
 * stored fleet on it, and reports what came back. The preflight prints
 * before anything stops. A failure on the way is a result, never a throw.
 */
export async function restartDaemon(options: RestartOptions): Promise<RestartResult> {
  const plan = await collectRestartPlan(options.callerSession);

  for (const line of formatRestartPreflight(plan)) {
    console.log(line);
  }

  const interrupted = (plan.sessions ?? [])
    .filter((session) => session.state === 'running')
    .map((session) => ({ name: session.name, id: session.id }));

  const buildFailure = (error: string): RestartResult =>
    buildRestartFailure(options.runID, error, interrupted);

  let expectedBuild: string | null = null;

  if (plan.replacement.kind === 'unit') {
    if (options.listen !== null || options.tokenFile !== null) {
      console.log('--listen and --token-file are ignored: the unit decides how the daemon starts');
    }

    const restarted = await runSystemctl(['restart', plan.replacement.unit]);

    if (restarted.code !== 0) {
      return buildFailure(`systemctl restart ${plan.replacement.unit} failed: ${restarted.stderr}`);
    }
  } else {
    expectedBuild = getBuild();

    const old = plan.pid === null ? buildOwnDaemonProcess() : readDaemonProcess(plan.pid);

    if (plan.pid !== null && !old.fromProc) {
      console.log(
        'cannot read /proc for the daemon: the replacement starts with this restart’s environment and without the old listener flags',
      );
    }

    if (plan.pid !== null) {
      const stopped = await stopDaemonProcess(plan.pid);

      const stoppedLine =
        stopped === 'killed'
          ? `the daemon (pid ${plan.pid}) ignored SIGTERM for 10 s, so it was killed with SIGKILL`
          : `stopped the daemon (pid ${plan.pid})`;

      console.log(stoppedLine);
    }

    startReplacementDaemon(old, { listen: options.listen, tokenFile: options.tokenFile });
  }

  const replacement = await waitForReplacement(plan.pid, expectedBuild, START_WAIT_MS);

  if (!replacement.ok) {
    return buildFailure(replacement.reason);
  }

  try {
    console.log(`daemon pid ${replacement.pid} is up (${replacement.build}); restoring the fleet`);

    const verdict = await verifyRestoredFleet(replacement.client, options.timeoutSeconds);

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
