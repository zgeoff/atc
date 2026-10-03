import { REPOSITORY_ENV_VARS } from './repository-env-vars';

interface GitRunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
  readonly isolated?: boolean;

  // How long the command may run before it is stopped and reported as
  // timed out; unset waits as long as git takes.
  readonly timeoutMs?: number;
}

interface GitRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Runs one git command to completion, feeding it any given input, and
 * returns its exit code and output. A command given a time limit is
 * stopped once it passes it, and reported as timed out.
 * git never prompts on a terminal here, since the daemon has none to answer
 * with, and its messages stay in the C locale so callers can read them.
 * Variables that pin git to some other repository, such as the `GIT_DIR` a
 * git hook exports, are dropped so the command acts on its own directory.
 *
 * An isolated command reads only the repository's own config and
 * attributes: the host's system and global config and its system and global
 * attributes files are ignored, and every LFS filter is switched off. A
 * checkout run this way runs no filter the host configured, so it can
 * neither execute host code nor reach the network with the host's
 * credentials.
 */
const ISOLATED_ARGS = [
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'filter.lfs.smudge=',
  '-c',
  'filter.lfs.process=',
  '-c',
  'filter.lfs.required=false',
];

const ISOLATED_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_LFS_SKIP_SMUDGE: '1',
};

export async function runGit(
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<GitRun> {
  const isolated = options.isolated === true;

  const proc = Bun.spawn(['git', ...(isolated ? ISOLATED_ARGS : []), ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: {
      ...collectHostEnv(),
      ...options.env,
      ...(isolated ? ISOLATED_ENV : {}),
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    },
    stdin: options.input === undefined ? 'ignore' : Buffer.from(options.input),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const finished = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (options.timeoutMs === undefined) {
    const [stdout, stderr, exitCode] = await finished;

    return { exitCode, stdout, stderr, timedOut: false };
  }

  // A stopped git can leave a helper holding its pipes open, so a timeout
  // answers without waiting for them to close.
  const limit = Promise.withResolvers<null>();

  const timer = setTimeout(() => {
    limit.resolve(null);
  }, options.timeoutMs);

  const settled = await Promise.race([finished, limit.promise]);

  clearTimeout(timer);

  if (settled === null) {
    proc.kill();

    return { exitCode: -1, stdout: '', stderr: '', timedOut: true };
  }

  const [stdout, stderr, exitCode] = settled;

  return { exitCode, stdout, stderr, timedOut: false };
}

function collectHostEnv(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !REPOSITORY_ENV_VARS.has(name) &&
        !name.startsWith('GIT_CONFIG_KEY_') &&
        !name.startsWith('GIT_CONFIG_VALUE_'),
    ),
  );
}
