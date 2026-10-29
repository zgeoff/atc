// grep exits 1 when no line matches, and 2 when it cannot read the file.
export function parseMatchingLines(stdout: string, exitCode: number): readonly string[] | null {
  if (exitCode === 1) {
    return [];
  }

  if (exitCode !== 0) {
    return null;
  }

  return stdout.endsWith('\n') ? stdout.slice(0, -1).split('\n') : stdout.split('\n');
}
