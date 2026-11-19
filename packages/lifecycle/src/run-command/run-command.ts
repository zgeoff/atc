export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly aborted: boolean;
}

interface CommandOptions {
  readonly env?: Readonly<Record<string, string>>;

  readonly signal?: Readonly<AbortSignal>;

  readonly stderr?: 'pipe' | 'ignore';

  readonly onSpawn?: (pid: number) => void;
}

export async function runCommand(
  argv: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  let subprocess: ReturnType<typeof spawnCommand>;

  try {
    subprocess = spawnCommand(argv, options);
  } catch (error) {
    return {
      code: 127,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      aborted: false,
    };
  }

  options.onSpawn?.(subprocess.pid);

  const finished = Promise.all([
    new Response(subprocess.stdout).text(),
    subprocess.stderr === undefined ? '' : new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  const settled = await waitForEnd(finished, options.signal);

  if (settled === null) {
    killProcessGroup(subprocess.pid);

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

    detached: options.signal !== undefined,
  });
}

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
    // ESRCH: the group already exited.
  }
}
