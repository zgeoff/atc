interface GitRunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

interface GitRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs one git command to completion and returns its exit code and output.
 * git never prompts on a terminal here, since the daemon has none to answer
 * with, and its messages stay in the C locale so callers can read them.
 * Variables that pin git to some other repository, such as the `GIT_DIR` a
 * git hook exports, are dropped so the command acts on its own directory.
 */
export async function runGit(
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<GitRun> {
  const proc = Bun.spawn(['git', ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...collectHostEnv(), ...options.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
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

const REPOSITORY_ENV_VARS: ReadonlySet<string> = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
]);

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
