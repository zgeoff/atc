export interface GHRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Runs gh with arguments and a time limit, killing its whole process group
 * once the limit passes, so a wrapper or extension leaves no process
 * behind. gh reads its own config and the host's environment for its
 * token, and is kept from prompting, colouring, or checking for updates.
 */
export async function runGH(
  bin: string,
  timeoutMs: number,
  args: readonly string[],
): Promise<GHRun> {
  const proc = Bun.spawn([bin, ...args], {
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_SPINNER_DISABLED: '1',
      NO_COLOR: '1',
      LC_ALL: 'C',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',

    // gh leads its own process group, so stopping it stops what it
    // started too.
    detached: true,
  });

  const finished = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const limit = Promise.withResolvers<null>();

  const timer = setTimeout(() => {
    limit.resolve(null);
  }, timeoutMs);

  const settled = await Promise.race([finished, limit.promise]);

  clearTimeout(timer);

  if (settled === null) {
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
