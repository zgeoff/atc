import type { CommandResult, CommandSpec } from '../index';

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
