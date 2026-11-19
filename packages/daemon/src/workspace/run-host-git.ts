import type { CommandResult, ExecutionProvider } from '@atc/plugin-api';
import { REPOSITORY_ENV_UNSET_ARGV } from './repository-env-unset-argv';
import { REPOSITORY_ENV_VARS } from './repository-env-vars';

// Files on a host may belong to another user, so git's ownership check would refuse them.
// fsmonitor stays off so a check never starts a background daemon.
const GIT_OPTIONS = ['-c', 'safe.directory=*', '-c', 'core.fsmonitor=false'];

export async function runHostGit(
  provider: ExecutionProvider,
  host: string,
  directory: string,
  args: readonly string[],
): Promise<CommandResult> {
  if (provider.remote) {
    return provider.runCommand({
      argv: [...REPOSITORY_ENV_UNSET_ARGV, 'git', ...GIT_OPTIONS, '-C', directory, ...args],
      cwd: '/',
      host,
    });
  }

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !REPOSITORY_ENV_VARS.has(name)),
  );

  const subprocess = Bun.spawn(['git', ...GIT_OPTIONS, '-C', directory, ...args], {
    cwd: '/',
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  return { exitCode, stdout, stderr };
}
