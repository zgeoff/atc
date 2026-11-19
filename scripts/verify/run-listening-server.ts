import type { Subprocess } from 'bun';

// Each server prints its startup line as the first line on stdout once it accepts requests.
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
