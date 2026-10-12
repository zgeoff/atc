import { runCommand } from './run-command';

interface ShellcheckResult {
  readonly exitCode: number | null;

  // One line per finding, as `-:<line>:<column>: <level>: <message> [SC<code>]`.
  readonly findings: readonly string[];
}

/**
 * Runs `shellcheck` over a shell program as the POSIX `sh` it runs under,
 * reading no `.shellcheckrc`, and resolves with its exit code and one line
 * per finding. A clean program exits 0 with no findings. Throws when
 * `shellcheck` is not on the PATH, so a host without it fails the test
 * instead of passing it unchecked.
 */
export async function runShellcheck(program: string): Promise<ShellcheckResult> {
  if (Bun.which('shellcheck', { PATH: process.env['PATH'] ?? '' }) === null) {
    throw new Error('shellcheck is not on the PATH; install it to run this test');
  }

  const run = await runCommand(['shellcheck', '--norc', '--shell=sh', '--format=gcc', '-'], {
    stdin: program,
  });

  return {
    exitCode: run.exitCode,
    findings: run.stdout.split('\n').filter((line) => line !== ''),
  };
}
