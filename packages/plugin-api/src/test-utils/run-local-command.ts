import type { CommandResult, CommandSpec } from '../index';

// the host is ignored, as the daemon's own machine takes none
export async function runLocalCommand(spec: CommandSpec): Promise<CommandResult> {
  const subprocess = Bun.spawn([...spec.argv], {
    cwd: spec.cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  return { exitCode, stdout, stderr };
}
