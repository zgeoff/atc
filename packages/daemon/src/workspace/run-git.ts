import { DEFAULT_GIT_TRANSPORTS } from '@atc/config';
import { DaemonError } from '@atc/protocol/wire';
import { REPOSITORY_ENV_VARS } from './repository-env-vars';

interface OpenOutputWatch {
  // Arms the bound to fire after the delay, and returns the function that
  // disarms it.
  readonly schedule: (fire: () => void, afterMs: number) => () => void;
  readonly report: (line: string) => void;
}

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

interface GitRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

// an isolated command reads only the repository's own config and attributes, so a checkout
// runs no filter the host configured: it can neither execute host code nor reach the network
// with the host's credentials
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

export async function runGit(
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<GitRun> {
  const isolated = options.isolated === true;

  const subprocess = Bun.spawn(['git', ...(isolated ? ISOLATED_ARGS : []), ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: {
      ...readHostEnv(),
      ...options.env,
      ...(isolated ? ISOLATED_ENV : {}),

      // the daemon has no terminal to answer a prompt, callers read git's messages in the C
      // locale, and git fetches only over the given transports, whatever a rewrite hands it
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

  options.onSpawn?.(subprocess.pid);

  const output = Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);

  const stopped = Promise.withResolvers<void>();

  const closed = waitForOutputClose({
    pid: subprocess.pid,
    exited: subprocess.exited,
    output,
    subcommand: findSubcommand(args) ?? 'command',
    watch: options.openOutputWatch ?? DEFAULT_OPEN_OUTPUT_WATCH,
    stopped: stopped.promise,
  });

  const finished = (async () => {
    const [[stdout, stderr], exitCode] = await Promise.all([output, subprocess.exited, closed]);

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
      process.kill(-subprocess.pid, 'SIGKILL');
    } catch {
      // The group already exited.
    }

    return { exitCode: -1, stdout: '', stderr: '', timedOut: true };
  }

  const [stdout, stderr, exitCode] = settled;

  return { exitCode, stdout, stderr, timedOut: false };
}

function readHostEnv(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !REPOSITORY_ENV_VARS.has(name) &&
        !name.startsWith('GIT_CONFIG_KEY_') &&
        !name.startsWith('GIT_CONFIG_VALUE_'),
    ),
  );
}

const OPEN_OUTPUT_BOUND_MS = 30_000;

interface WaitForOutputCloseOptions {
  readonly pid: number;
  readonly exited: Readonly<Promise<number>>;
  readonly output: Readonly<Promise<unknown>>;
  readonly subcommand: string;
  readonly watch: OpenOutputWatch;
  readonly stopped: Readonly<Promise<void>>;
}

// the hangup of output whose writer is gone may never arrive, so past the bound the run
// reports which git it waited on, kills git's process group, and fails
async function waitForOutputClose(options: WaitForOutputCloseOptions): Promise<void> {
  const pid = options.pid;
  const subcommand = options.subcommand;
  const watch = options.watch;

  const exitCode = await options.exited;

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
    await Promise.race([options.output, bound.promise, options.stopped]);
  } finally {
    disarm();
  }
}

// The git subcommand among the arguments: the first that is neither an
// option nor the value of a `-c` or `-C`. The report holds only it, since
// another argument, such as a URL, can hold a credential.
function findSubcommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === '-c' || arg === '-C') {
      index++;
    } else if (arg !== undefined && !arg.startsWith('-')) {
      return arg;
    }
  }

  return undefined;
}
