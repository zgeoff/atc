import { REPOSITORY_ENV_VARS } from '../workspace/repository-env-vars';
import type { CommandResult, ExecutionProvider } from './execution-provider';

// The git options every check runs with: every directory counts as safe,
// since a host's files may belong to another user than the one the command
// runs as, and no fsmonitor starts.
const GIT_OPTIONS = ['-c', 'safe.directory=*', '-c', 'core.fsmonitor=false'];

// A remote host runs git without the variables that would point it at
// another repository than the directory it is given.
const CLEAN_ENV = ['env', ...[...REPOSITORY_ENV_VARS].flatMap((name) => ['-u', name])];

/**
 * Runs git against a directory on a session's host and returns what it
 * printed. A provider on the daemon's own machine shares the daemon's
 * filesystem, so the daemon runs git there itself; a remote host runs it
 * through the provider.
 */
export async function runHostGit(
  provider: ExecutionProvider,
  host: string,
  dir: string,
  args: readonly string[],
): Promise<CommandResult> {
  if (provider.remote) {
    return provider.runCommand({
      argv: [...CLEAN_ENV, 'git', ...GIT_OPTIONS, '-C', dir, ...args],
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
