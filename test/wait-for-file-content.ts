import { existsSync, readFileSync } from 'node:fs';

/**
 * Polls a file every 20ms until it exists and its text satisfies `isReady`,
 * then returns that text. Throws, naming the path, when `timeoutMs` passes
 * first — the file never appearing and the predicate never passing fail the
 * same way.
 */
export async function waitForFileContent(
  path: string,
  isReady: (text: string) => boolean = () => true,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8');

      if (isReady(text)) {
        return text;
      }
    }

    await Bun.sleep(20);
  }

  throw new Error(`timed out waiting for file content at ${path}`);
}
