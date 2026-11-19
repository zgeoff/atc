import type { Endpoints, RepoExec } from '@wringer/core';
import { buildHomeCommand } from './build-home-command.ts';
import { parseRunEndpoints } from './run-endpoints.ts';

interface CLIRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// Runs the atc CLI of this checkout in the run's home with the arguments, and returns what it
// exited with and printed, whatever the exit code, so a journey can check a command that exits
// non-zero on purpose.
export async function runCLICommand(
  exec: RepoExec,
  endpoints: Endpoints,
  cliEntry: string,
  argv: readonly string[],
): Promise<CLIRun> {
  const run = parseRunEndpoints(endpoints);

  const result = await exec(buildHomeCommand(run.root, [process.execPath, cliEntry, ...argv]));

  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}
