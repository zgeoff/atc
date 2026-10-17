import type { CommandResult, CommandSpec } from '@atc/plugin-api';

// the host is ignored, as the daemon's own machine takes none
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
