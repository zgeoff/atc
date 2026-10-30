export function formatCommitLines(commits: readonly string[]): string {
  return commits.map((commit) => `${commit}\n`).join('');
}
