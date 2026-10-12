export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `argv` with no input and returns its exit code and its output, each
 * trimmed. A command that cannot start, such as one missing from PATH,
 * reads as exit code 127 with the spawn error as its stderr, the way a
 * shell reports it.
 */
export async function runCommand(argv: readonly string[]): Promise<CommandResult> {
  try {
    const proc = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });

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
