import type { Subprocess } from 'bun';

// Starts a server of the run, `atc mcp --http` or `atc-gateway serve`, and waits for the startup
// line that each prints as its first line on stdout once it accepts requests. Its stderr, where it
// logs requests and refusals, goes to the run's app log.
export async function runListeningServer(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<Subprocess<'ignore', 'pipe', 'inherit'>> {
  const server = Bun.spawn([...argv], {
    env: { ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
  });

  const reader = server.stdout.getReader();

  const decoder = new TextDecoder();

  let printed = '';

  while (!printed.includes('\n')) {
    const chunk = await reader.read();

    if (chunk.done) {
      throw new Error(`${argv.join(' ')} exited before it printed its startup line: ${printed}`);
    }

    printed += decoder.decode(chunk.value, { stream: true });
  }

  reader.releaseLock();

  return server;
}
