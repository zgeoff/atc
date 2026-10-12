import type { HostServices } from '@atc/plugin-api/host-services';
import { runGH } from './run-gh';

/**
 * The clone protocol the gh config on this host prefers: `ssh` when it says
 * so, else `https`, which a gh that fails or takes too long also gives.
 */
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
