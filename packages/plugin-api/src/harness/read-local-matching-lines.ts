import { parseMatchingLines } from './parse-matching-lines';

// A transcript can run to many megabytes, so grep picks the lines out of it.
export async function readLocalMatchingLines(
  path: string,
  pattern: string,
): Promise<readonly string[] | null> {
  let subprocess: Bun.Subprocess<'ignore', 'pipe', 'ignore'>;

  try {
    subprocess = Bun.spawn(['grep', '-E', '--', pattern, path], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    });
  } catch {
    return null;
  }

  const [stdout, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    subprocess.exited,
  ]);

  return parseMatchingLines(stdout, exitCode);
}
