export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly aborted: boolean;
}

interface CommandOptions {
  // Variables the command gets over this process's own environment.
  readonly env?: Readonly<Record<string, string>>;

  // Aborting it kills the command's whole process group.
  readonly signal?: Readonly<AbortSignal>;

  // With 'ignore', the command's stderr goes nowhere and the run never waits
  // for it to close, so a child that keeps stderr open cannot hold the run.
  readonly stderr?: 'pipe' | 'ignore';

  // Called with the pid of the started command right after it starts; with
  // a signal, that pid is also its process group's id.
  readonly onSpawn?: (pid: number) => void;
}

export async function runCommand(
  argv: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  let proc: ReturnType<typeof spawnCommand>;

  try {
    proc = spawnCommand(argv, options);
  } catch (error) {
    return {
      code: 127,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      aborted: false,
    };
  }

  options.onSpawn?.(proc.pid);

  const finished = Promise.all([
    new Response(proc.stdout).text(),
    proc.stderr === undefined ? '' : new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const settled = await waitForEnd(finished, options.signal);

  if (settled === null) {
    killProcessGroup(proc.pid);

    return { code: -1, stdout: '', stderr: '', aborted: true };
  }

  const [stdout, stderr, code] = settled;

  return { code, stdout: stdout.trim(), stderr: stderr.trim(), aborted: false };
}

function spawnCommand(argv: readonly string[], options: CommandOptions) {
  return Bun.spawn([...argv], {
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: options.stderr ?? 'pipe',

    // A command that an abort can stop leads its own process group, so
    // stopping it stops what it started too.
    detached: options.signal !== undefined,
  });
}

// The command's output and exit, or null once the signal aborts first.
async function waitForEnd<T>(
  finished: Readonly<Promise<T>>,
  signal: Readonly<AbortSignal> | undefined,
) {
  if (signal === undefined) {
    return finished;
  }

  const aborted = Promise.withResolvers<null>();

  const onAbort = () => {
    aborted.resolve(null);
  };

  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const settled = await Promise.race([finished, aborted.promise]);

  signal.removeEventListener('abort', onAbort);

  return settled;
}

function killProcessGroup(group: number): void {
  try {
    process.kill(-group, 'SIGKILL');
  } catch {
    // The group already exited.
  }
}
