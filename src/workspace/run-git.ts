import { REPOSITORY_ENV_VARS } from './repository-env-vars';

interface GitRunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
  readonly isolated?: boolean;
}

interface GitRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs one git command to completion, feeding it any given input, and
 * returns its exit code and output.
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

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
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
