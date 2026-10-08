import { registerTestCleanup } from './register-test-cleanup';

interface CommandOptions {
  readonly cwd?: string;

  // The whole environment of the run, as the spawn takes it; left out, the
  // run inherits the test's environment.
  readonly env?: Readonly<Record<string, string | undefined>>;

  readonly stdin?: string | Buffer;
}

interface CommandResult {
  // Null when a signal ended the run.
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a command as its own process and resolves once it exits and its
 * output closes, with its exit code, the signal that ended it, and
 * everything it printed. The run never blocks the test's event loop, so the
 * test's timeout still applies. The command leads a process group of its
 * own, and a run still incomplete when the test finishes has that whole
 * group killed, so a child the command left holding its output ends too.
 * Call it only inside a test, never from a cleanup.
 */
export async function runCommand(
  cmd: readonly string[],
  options: Readonly<CommandOptions> = {},
): Promise<CommandResult> {
  const proc = Bun.spawn([...cmd], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    stdin: options.stdin === undefined ? 'ignore' : Buffer.from(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  });

  let complete = false;

  registerTestCleanup(async () => {
    if (!complete) {
      killProcessGroup(proc.pid);
    }

    await proc.exited;
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  complete = true;

  return { exitCode: proc.exitCode, signalCode: proc.signalCode, stdout, stderr };
}

// A group already empty has nothing left to kill.
function killProcessGroup(group: number): void {
  try {
    process.kill(-group, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && Reflect.get(error, 'code') === 'ESRCH')) {
      throw error;
    }
  }
}
