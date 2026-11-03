// `git diff --cached --quiet` exits 0 when nothing is staged and 1 when something is; any other
// status is git failing, which the update must never read as a formula already in place.
export function pickFormulaCommitMessage(diffExitCode: number, version: string): string | null {
  if (diffExitCode === 0) {
    return null;
  }

  if (diffExitCode === 1) {
    return `atc ${version}`;
  }

  throw new Error(`git diff --cached exited ${diffExitCode}`);
}
