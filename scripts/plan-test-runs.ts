// Splits the selected test files into test-script runs so that the tests on
// the skip list stay out: one run for the files with no skipped test, then
// one run per file that has a skipped test, filtered by test name.
import type { TestSkip } from './load-test-skips';

export interface TestRun {
  // The arguments after `bun run test`
  args: string[];
  skips: TestSkip[];
}

export function planTestRuns(files: readonly string[], skips: readonly TestSkip[]): TestRun[] {
  const plain = files.filter((file) => !skips.some((skip) => skip.file === file));
  const unit = plain.filter((file) => !file.startsWith('e2e/'));
  const journeys = plain.filter((file) => file.startsWith('e2e/'));

  // Each e2e test starts a daemon and its sessions from source, and two
  // workers on a 2-CPU host stretch those start-ups past the 5 s test limit
  const runs: TestRun[] = [
    ...(unit.length > 0 ? [{ args: unit, skips: [] }] : []),
    ...(journeys.length > 0 ? [{ args: ['--parallel=1', ...journeys], skips: [] }] : []),
  ];

  for (const file of files) {
    const fileSkips = skips.filter((skip) => skip.file === file);

    if (fileSkips.length > 0) {
      runs.push({
        // a file whose every test is skipped matches no test, which is a pass
        args: [
          file,
          '--pass-with-no-tests',
          '--test-name-pattern',
          buildSkipPattern(fileSkips.map((skip) => skip.test)),
        ],
        skips: fileSkips,
      });
    }
  }

  return runs;
}

// Bun matches the pattern against a test's full name, its describe titles
// and its own title joined by spaces, so the pattern refuses exactly the
// listed full names and accepts every other name.
function buildSkipPattern(names: readonly string[]): string {
  const alternatives = names.map((name) =>
    name.replaceAll(/[\\^$.*+?()[\]{}|]/gu, String.raw`\$&`),
  );

  return `^(?!(?:${alternatives.join('|')})$)`;
}
