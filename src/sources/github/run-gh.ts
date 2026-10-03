export interface GHRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Runs gh with arguments and a time limit, killing it once the limit
 * passes. gh reads its own config and the host's environment for its
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
    proc.kill();

    return { exitCode: -1, stdout: '', stderr: '', timedOut: true };
  }

  const [stdout, stderr, exitCode] = settled;

  return { exitCode, stdout, stderr, timedOut: false };
}
