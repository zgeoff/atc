import type { CommandResult, ExecutionProvider } from '@atc/plugin-api';
import { REPOSITORY_ENV_UNSET_ARGV } from './repository-env-unset-argv';
import { REPOSITORY_ENV_VARS } from './repository-env-vars';

// The git options every check runs with: every directory counts as safe,
// since a host's files may belong to another user than the one the command
// runs as, and no fsmonitor starts.
const GIT_OPTIONS = ['-c', 'safe.directory=*', '-c', 'core.fsmonitor=false'];

// A remote host runs git without the variables that would point it at
// another repository than the directory it is given.

export async function runHostGit(
  provider: ExecutionProvider,
  host: string,
  dir: string,
  args: readonly string[],
): Promise<CommandResult> {
  if (provider.remote) {
    return provider.runCommand({
      argv: [...REPOSITORY_ENV_UNSET_ARGV, 'git', ...GIT_OPTIONS, '-C', dir, ...args],
      cwd: '/',
      host,
    });
  }

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !REPOSITORY_ENV_VARS.has(name)),
  );

  const proc = Bun.spawn(['git', ...GIT_OPTIONS, '-C', dir, ...args], {
    cwd: '/',
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}
