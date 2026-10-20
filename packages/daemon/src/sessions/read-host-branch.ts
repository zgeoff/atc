import type { ExecutionProvider } from '@atc/plugin-api';
import { runHostGit } from '../workspace/run-host-git';

export async function readHostBranch(
  provider: ExecutionProvider,
  host: string,
  directory: string,
): Promise<string | null> {
  if (provider.remote && !provider.capabilities.run) {
    return null;
  }

  const head = await runHostGit(provider, host, directory, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]);

  const branch = head.stdout.trim();

  return head.exitCode === 0 && branch !== '' ? branch : null;
}
