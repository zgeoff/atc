import { dirname } from 'node:path';
import type { StepTimer } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';
import type { ProgressTracker } from './materialization-progress';
import type { Landing, MaterializeDeps } from './materialize-deps';
import type { MaterializeRequest } from './materialize-request';

// How many directories a spawn whose directory the daemon picked tries
// before it refuses.
const AUTO_DIR_ATTEMPTS = 100;

export async function claimLanding(
  request: MaterializeRequest,
  deps: MaterializeDeps,
  updateProgress: ProgressTracker,
  timer: StepTimer,
): Promise<Landing> {
  // a picked directory moves to the next attempt while it exists or another workspace holds
  // it, so repeated and concurrent spawns of one repository land side by side
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

// exits with the parent status when the parent cannot be created, with the present status
// when anything, a dangling symlink included, stands at the directory's path, and 5 otherwise
const PARENT_FAILED_EXIT = 3;
const DIR_PRESENT_EXIT = 4;

export const CLAIM_DIR_SCRIPT = `mkdir -p -- "$1" || exit ${PARENT_FAILED_EXIT}
mkdir -- "$2" && exit 0
if [ -e "$2" ] || [ -L "$2" ]; then exit ${DIR_PRESENT_EXIT}; fi
exit 5`;

// `mkdir` without `-p` fails when the directory exists, so a materialization never unpacks
// over files it did not put there
async function claimTargetDir(
  request: MaterializeRequest,
  deps: MaterializeDeps,
  landing: Landing,
  updateProgress: ProgressTracker,
): Promise<void> {
  // A directory the daemon picked is reported as it landed.
  const shown = request.autoDir === true ? landing.directory : request.directory;

  const claim = await deps.requireProvider('run').runCommand({
    argv: ['sh', '-c', CLAIM_DIR_SCRIPT, 'sh', dirname(landing.directory), landing.directory],
    cwd: '/',
    host: landing.host,
  });

  if (claim.exitCode === PARENT_FAILED_EXIT) {
    throw new DaemonError(
      'transfer_failed',
      `cannot create ${dirname(shown)} on target '${request.target}': ${claim.stderr.trim()}`,
      { phase: 'resolving', dir: shown },
    );
  }

  if (claim.exitCode === DIR_PRESENT_EXIT) {
    throw new DaemonError(
      'workspace_exists',
      `${shown} already exists on target '${request.target}'; a workspace is materialized only into a directory that does not exist`,
      { phase: 'resolving', dir: shown },
    );
  }

  // A directory that is not there failed for another reason, such as a
  // parent the command cannot write, which no other attempt would fix.
  if (claim.exitCode !== 0) {
    throw new DaemonError(
      'transfer_failed',
      `cannot create ${shown} on target '${request.target}': ${claim.stderr.trim()}`,
      { phase: 'resolving', dir: shown },
    );
  }

  updateProgress({ claimed: true });
}
