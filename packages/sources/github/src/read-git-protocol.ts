import { runGH } from '@atc/plugin-api';
import type { HostServices } from '@atc/plugin-api';

export async function readGitProtocol(
  run: HostServices['runCommand'],
  bin: string,
  timeoutMs: number,
): Promise<'https' | 'ssh'> {
  const ran = await runGH(run, bin, AbortSignal.timeout(timeoutMs), [
    'config',
    'get',
    'git_protocol',
  ]);

  return ran.exitCode === 0 && ran.stdout.trim() === 'ssh' ? 'ssh' : 'https';
}
