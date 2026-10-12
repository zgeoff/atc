import { runGH } from './run-gh';

/**
 * The clone protocol the gh config on this host prefers: `ssh` when it says
 * so, else `https`, which a gh that fails or takes too long also gives.
 */
export async function readGitProtocol(bin: string, timeoutMs: number): Promise<'https' | 'ssh'> {
  const run = await runGH(bin, AbortSignal.timeout(timeoutMs), ['config', 'get', 'git_protocol']);

  return run.exitCode === 0 && run.stdout.trim() === 'ssh' ? 'ssh' : 'https';
}
