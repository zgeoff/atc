import type { HostServices } from '@atc/plugin-api/host-services';

/**
 * zoxide's frecency list, most visited first, through the host's command
 * runner. An absent zoxide or a failed query contributes nothing, so the
 * picker never depends on it.
 */
export async function collectZoxideDirs(run: HostServices['runCommand']): Promise<string[]> {
  const listed = await run(['zoxide', 'query', '-l']);

  return listed.code === 0 ? listed.stdout.split('\n').filter((line) => line !== '') : [];
}
