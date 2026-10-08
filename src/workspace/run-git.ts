import { DaemonError } from '../protocol/daemon-error';
import { DEFAULT_GIT_TRANSPORTS } from '../shared/default-git-transports';
import { REPOSITORY_ENV_VARS } from './repository-env-vars';

interface GitRunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
  readonly isolated?: boolean;

  // How long the command may run before it is stopped and reported as
  // timed out; unset waits as long as git takes.
  readonly timeoutMs?: number;

  // The transports git may fetch over; https and ssh when unset.
  readonly transports?: readonly string[];

  // Called with the pid of the started git right after it starts; that pid
  // is also its process group's id.
  readonly onSpawn?: ((pid: number) => void) | undefined;

  // Bounds the wait for the output of a git that has exited; a 30 s timer
  // and a line on stderr when unset.
  readonly openOutputWatch?: OpenOutputWatch;
}

interface OpenOutputWatch {
  // Arms the bound to fire after the delay, and returns the function that
  // disarms it.
  readonly schedule: (fire: () => void, afterMs: number) => () => void;
  readonly report: (line: string) => void;
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
 * stopped once it passes it, with every process it started, and reported
 * as timed out. Once git exits, its output has 30 s to close: output that
 * a process git left holds open past that kills git's process group and
 * fails the run with `git_output_open`.
 * git never prompts on a terminal here, since the daemon has none to answer
 * with, its messages stay in the C locale so callers can read them, and it
 * fetches only over the transports it is given, https and ssh unless told
 * otherwise, whatever URL a host config rewrite or a submodule hands it.
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
      GIT_ALLOW_PROTOCOL: (options.transports ?? DEFAULT_GIT_TRANSPORTS).join(':'),
    },
    stdin: options.input === undefined ? 'ignore' : Buffer.from(options.input),
    stdout: 'pipe',
    stderr: 'pipe',

    // Every git leads its own process group, so stopping it stops the
    // helpers it started, such as `git remote-http`, too.
    detached: true,
  });

  options.onSpawn?.(proc.pid);
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const stopped = Promise.withResolvers<void>();

  const closed = waitForOutputClose(
    proc.pid,
    proc.exited,
    output,
    findSubcommand(args) ?? 'command',
    options.openOutputWatch ?? DEFAULT_OPEN_OUTPUT_WATCH,
    stopped.promise,
  );

  const finished = (async () => {
    const [[stdout, stderr], exitCode] = await Promise.all([output, proc.exited, closed]);

    return [stdout, stderr, exitCode] as const;
  })();

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

  let settled: Awaited<typeof finished> | null;

  try {
    settled = await Promise.race([finished, limit.promise]);
  } finally {
    clearTimeout(timer);
  }

  if (settled === null) {
    // The group is stopped here, so the bound has nothing left to wait for.
    stopped.resolve();

    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      // The group already exited.
    }

    return { exitCode: -1, stdout: '', stderr: '', timedOut: true };
  }

  const [stdout, stderr, exitCode] = settled;

  return { exitCode, stdout, stderr, timedOut: false };
}

const OPEN_OUTPUT_BOUND_MS = 30_000;

const DEFAULT_OPEN_OUTPUT_WATCH: OpenOutputWatch = {
  schedule: (fire, afterMs) => {
    const timer = setTimeout(fire, afterMs);

    timer.unref();

    return () => {
      clearTimeout(timer);
    };
  },
  report: (line) => {
    console.error(line);
  },
};

// A run waits for git's output to close as well as for its exit, so output
// that stays open after the exit holds the run. Past the bound, a line says
// which git it waited on, git's process group is killed, and the wait
// fails, since the hangup of output whose writer is gone may never arrive.
// It resolves once the output closes or the run stops the group itself.
async function waitForOutputClose(
  pid: number,
  exited: Readonly<Promise<number>>,
  output: Readonly<Promise<unknown>>,
  subcommand: string,
  watch: OpenOutputWatch,
  stopped: Readonly<Promise<void>>,
): Promise<void> {
  const exitCode = await exited;

  const bound = Promise.withResolvers<never>();

  const disarm = watch.schedule(() => {
    const message = `git ${subcommand} exited ${exitCode}, but its output was still open ${OPEN_OUTPUT_BOUND_MS} ms later`;

    watch.report(`atc: ${message}; killing its process group`);

    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group already exited.
    }

    bound.reject(new DaemonError('git_output_open', message, { subcommand, exitCode }));
  }, OPEN_OUTPUT_BOUND_MS);

  try {
    await Promise.race([output, bound.promise, stopped]);
  } finally {
    disarm();
  }
}

// The git subcommand among the arguments: the first that is neither an
// option nor the value of a `-c` or `-C`. The report holds only it, since
// another argument, such as a URL, can hold a credential.
function findSubcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-c' || arg === '-C') {
      i++;
    } else if (arg !== undefined && !arg.startsWith('-')) {
      return arg;
    }
  }

  return undefined;
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
