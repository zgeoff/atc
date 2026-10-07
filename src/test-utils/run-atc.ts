interface ATCRun {
  // The command atc runs as, such as the source entry under bun or a
  // compiled binary.
  readonly command: readonly string[];

  readonly args: readonly string[];

  // HOME and XDG_RUNTIME_DIR for the run, so it finds the daemon and the
  // state of this home alone.
  readonly home: string;

  // Variables laid over the inherited environment; `undefined` removes one.
  readonly env?: Readonly<Record<string, string | undefined>>;

  readonly stdin?: string;
  readonly cwd?: string;
}

interface ATCResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs one atc subcommand as its own process against a home and resolves
 * once it exits, with its exit code and everything it printed. The process
 * inherits the test's environment with HOME and XDG_RUNTIME_DIR pointed at
 * the home, then the run's own variables over that.
 */
export async function runATC(run: Readonly<ATCRun>): Promise<ATCResult> {
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: run.home,
      XDG_RUNTIME_DIR: run.home,
      ...run.env,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

  const proc = Bun.spawn([...run.command, ...run.args], {
    env,
    ...(run.cwd === undefined ? {} : { cwd: run.cwd }),
    stdin: run.stdin === undefined ? 'ignore' : new TextEncoder().encode(run.stdin),
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
