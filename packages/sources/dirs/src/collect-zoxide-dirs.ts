import type { HostServices } from '@atc/plugin-api';

export async function collectZoxideDirs(run: HostServices['runCommand']): Promise<string[]> {
  const listed = await run(['zoxide', 'query', '-l']);

  return listed.code === 0 ? listed.stdout.split('\n').filter((line) => line !== '') : [];
}
