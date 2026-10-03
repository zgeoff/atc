/**
 * zoxide's frecency list, most visited first. An absent zoxide or a failed
 * query contributes nothing, so the picker never depends on it.
 */
export async function collectZoxideDirs(): Promise<string[]> {
  try {
    const proc = Bun.spawn(['zoxide', 'query', '-l'], { stdout: 'pipe', stderr: 'ignore' });

    const text = await new Response(proc.stdout).text();

    return text.split('\n').filter((line) => line !== '');
  } catch {
    return [];
  }
}
