import type { Subprocess } from 'bun';
import { killProcessGroup } from './kill-process-group';
import { registerTestCleanup } from './register-test-cleanup';

interface CommandOptions {
  readonly cwd?: string;

  // Node's spawn uses this object as the child's entire environment and does not merge it
  // with the parent's; leave it out and the child inherits the test's environment.
  readonly env?: Readonly<Record<string, string | undefined>>;

  readonly stdin?: string | Buffer;
}

interface CommandResult {
  // Null when a signal ended the run.
  readonly exitCode: number | null;
  readonly signalCode: Subprocess['signalCode'];
  readonly stdout: string;
  readonly stderr: string;
}

// Call it only inside a test, never from a cleanup, since it registers a
// cleanup of its own.
export async function runCommand(
  cmd: readonly string[],
  options: Readonly<CommandOptions> = {},
): Promise<CommandResult> {
  const subprocess = Bun.spawn([...cmd], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    stdin: options.stdin === undefined ? 'ignore' : Buffer.from(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',

    // Leading its own process group lets the cleanup kill a child the command
    // left holding its output.
    detached: true,
  });

  let complete = false;

  registerTestCleanup(async () => {
    if (!complete) {
      killProcessGroup(subprocess.pid);
    }

    await subprocess.exited;
  });

  const [stdout, stderr] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  complete = true;

  return { exitCode: subprocess.exitCode, signalCode: subprocess.signalCode, stdout, stderr };
}
