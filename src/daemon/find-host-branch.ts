import type { ExecutionProvider } from './execution-provider';
import { runHostGit } from './run-host-git';

/**
 * The branch a directory on a session's host has checked out; null for a
 * detached checkout, a directory outside git, or a remote host that runs
 * no commands.
 */
export async function findHostBranch(
  provider: ExecutionProvider,
  host: string,
  dir: string,
): Promise<string | null> {
  if (provider.remote && !provider.capabilities.run) {
    return null;
  }

  const head = await runHostGit(provider, host, dir, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]);

  const branch = head.stdout.trim();

  return head.exitCode === 0 && branch !== '' ? branch : null;
}
