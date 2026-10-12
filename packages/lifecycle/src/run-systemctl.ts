interface SystemctlResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `systemctl --user` with `args` and returns its exit code and output.
 * A machine without systemctl reads as exit code 127.
 */
export async function runSystemctl(args: readonly string[]): Promise<SystemctlResult> {
  try {
    const proc = Bun.spawn(['systemctl', '--user', ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return {
      code: 127,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}
