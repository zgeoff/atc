import type { CommandResult, CommandSpec } from '@atc/plugin-api';

/**
 * Runs a command on this machine as the local provider runs one: the argv
 * in the spec's directory, with no input and the test's own environment,
 * and returns its exit code and its output untrimmed. It ignores the host,
 * as the daemon's own machine takes none. A test hands it to an in-memory
 * provider whose commands must reach a real program, such as git.
 */
export async function runLocalCommand(spec: CommandSpec): Promise<CommandResult> {
  const proc = Bun.spawn([...spec.argv], {
    cwd: spec.cwd,
    stdin: 'ignore',
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
