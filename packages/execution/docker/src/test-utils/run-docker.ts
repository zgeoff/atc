// Runs the docker CLI against the machine's Engine and returns its trimmed output.
export async function runDocker(...args: string[]): Promise<string> {
  const process = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`docker ${args.join(' ')} failed: ${stderr}`);
  }

  return stdout.trim();
}
