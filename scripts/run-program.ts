export interface ProgramOptions {
  readonly cwd: string;

  // The whole environment of the program; it inherits nothing from this process.
  readonly env: Readonly<Record<string, string | undefined>>;

  readonly stdin?: string;
}

export interface ProgramResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunProgram = (
  argv: readonly string[],
  options: Readonly<ProgramOptions>,
) => ProgramResult;

export function runProgram(
  argv: readonly string[],
  options: Readonly<ProgramOptions>,
): ProgramResult {
  const result = Bun.spawnSync([...argv], {
    cwd: options.cwd,
    env: { ...options.env },
    stdin: options.stdin === undefined ? 'ignore' : Buffer.from(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
