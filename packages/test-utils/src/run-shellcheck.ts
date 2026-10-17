import { runCommand } from './run-command';

interface ShellcheckResult {
  readonly exitCode: number | null;

  // One line per finding, as `-:<line>:<column>: <level>: <message> [SC<code>]`.
  readonly findings: readonly string[];
}

export async function runShellcheck(program: string): Promise<ShellcheckResult> {
  // A host without shellcheck fails the test instead of passing it unchecked.
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
