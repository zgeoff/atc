import { dirname } from 'node:path';
import type { StepTimer } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';
import type { ProgressTracker } from './materialization-progress';
import type { Landing, MaterializeDeps } from './materialize-deps';
import type { MaterializeRequest } from './materialize-request';

const AUTO_DIR_ATTEMPTS = 100;

export async function claimLanding(
  request: MaterializeRequest,
  deps: MaterializeDeps,
  updateProgress: ProgressTracker,
  timer: StepTimer,
): Promise<Landing> {
  const attempts = request.autoDir === true ? AUTO_DIR_ATTEMPTS : 1;

  for (let attempt = 1; ; attempt += 1) {
    try {
      const landing = await deps.readyHost(attempt);

      updateProgress({ landing });

      await timer.withStep('dir-create', () =>
        claimTargetDir(request, deps, landing, updateProgress),
      );

      return landing;
    } catch (error) {
      const held =
        error instanceof DaemonError &&
        (error.code === 'workspace_exists' || error.code === 'workspace_overlap');

      if (!held || attempt >= attempts) {
        throw error;
      }
    }
  }
}

const PARENT_FAILED_EXIT = 3;
const DIR_PRESENT_EXIT = 4;

export const CLAIM_DIR_SCRIPT = `mkdir -p -- "$1" || exit ${PARENT_FAILED_EXIT}
mkdir -- "$2" && exit 0
if [ -e "$2" ] || [ -L "$2" ]; then exit ${DIR_PRESENT_EXIT}; fi
exit 5`;

async function claimTargetDir(
  request: MaterializeRequest,
  deps: MaterializeDeps,
  landing: Landing,
  updateProgress: ProgressTracker,
): Promise<void> {
  const shown = request.autoDir === true ? landing.directory : request.directory;
  const args = [dirname(landing.directory), landing.directory];

  const claim = await deps.requireProvider('run').runCommand({
    argv: ['sh', '-c', CLAIM_DIR_SCRIPT, 'sh', ...args],
    cwd: '/',
    host: landing.host,
  });

  deps.log(
    `atc: debug: workspace for session ${request.sessionID} ran the directory claim with ${JSON.stringify(args)} on target '${request.target}': exit ${claim.exitCode}`,
  );

  if (claim.exitCode === PARENT_FAILED_EXIT) {
    throw new DaemonError(
      'transfer_failed',
      `cannot create ${dirname(shown)} on target '${request.target}': ${claim.stderr.trim()}`,
      { phase: 'resolving', directory: shown },
    );
  }

  if (claim.exitCode === DIR_PRESENT_EXIT) {
    throw new DaemonError(
      'workspace_exists',
      `${shown} already exists on target '${request.target}'; a workspace is materialized only into a directory that does not exist`,
      { phase: 'resolving', directory: shown },
    );
  }

  if (claim.exitCode !== 0) {
    throw new DaemonError(
      'transfer_failed',
      `cannot create ${shown} on target '${request.target}': ${claim.stderr.trim()}`,
      { phase: 'resolving', directory: shown },
    );
  }

  updateProgress({ claimed: true });
}
