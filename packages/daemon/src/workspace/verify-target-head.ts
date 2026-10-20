import { DaemonError } from '@atc/protocol/wire';
import type { Landing, MaterializeDeps } from './materialize-deps';
import type { MaterializeRequest } from './materialize-request';
import { REPOSITORY_ENV_UNSET_ARGV } from './repository-env-unset-argv';

// The provider runs commands in its own environment, so the verify unsets
// every variable that could point git at another repository first.

// prints the commit HEAD resolves to and a NUL, then every tracked file whose content differs
// from HEAD, so a file the unpack left out or changed refuses the checkout whatever tar did;
// a HEAD that resolves to no commit exits at once, before the NUL
export const VERIFY_SCRIPT = String.raw`git rev-parse --verify 'HEAD^{commit}' || exit 1; printf '\0'; exec git -c core.fsmonitor=false status --porcelain --untracked-files=no`;

export async function verifyTargetHead(
  request: MaterializeRequest,
  deps: MaterializeDeps,
  landing: Landing,
  sha: string,
): Promise<void> {
  const verified = await deps.requireProvider('run').runCommand({
    argv: [...REPOSITORY_ENV_UNSET_ARGV, 'sh', '-c', VERIFY_SCRIPT],
    cwd: landing.directory,
    host: landing.host,
  });

  const split = verified.stdout.indexOf('\0');
  const actual = split === -1 ? null : verified.stdout.slice(0, split).trim();

  if (actual !== sha) {
    throw new DaemonError(
      'workspace_mismatch',
      `the checkout on target '${request.target}' is at ${actual ?? 'no commit'}, not ${sha}`,
      { phase: 'verifying', expected: sha, actual },
    );
  }

  const changed = verified.stdout
    .slice(split + 1)
    .split('\n')
    .filter((line) => line !== '');

  if (verified.exitCode !== 0 || changed.length > 0) {
    throw new DaemonError(
      'workspace_mismatch',
      `the checkout on target '${request.target}' does not match ${sha} in its tracked files: ${changed.slice(0, 5).join('; ') || verified.stderr.trim()}`,
      { phase: 'verifying', expected: sha, actual },
    );
  }
}
