// Runs the tests that sit beside the given files: a test file runs itself,
// and a source file runs its sibling test file. The tests on the pre-push
// skip list stay out, each with a printed line that holds its Linear issue.
import { existsSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';
import type { TestSkip } from './load-test-skips';
import { loadTestSkips } from './load-test-skips';
import { pickTestWorkers } from './pick-test-workers';
import { planTestRuns } from './plan-test-runs';

export function readRelatedTests(paths: readonly string[], cwd: string): string[] {
  const selected = new Set<string>();

  for (const path of paths) {
    if (path.endsWith('.test.ts')) {
      if (existsSync(join(cwd, path))) {
        selected.add(path);
      }
    } else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) {
      const sibling = `${path.slice(0, -'.ts'.length)}.test.ts`;

      if (existsSync(join(cwd, sibling))) {
        selected.add(sibling);
      }
    }
  }

  return [...selected].filter(
    (test) => !test.endsWith(LANE_SUFFIX) && !test.startsWith(E2E_DIRECTORY),
  );
}

// A lane suite runs a real system through its own script, such as `test:codex`
// or, for every suite under `e2e/`, `test:e2e`.
const LANE_SUFFIX = '.codex.test.ts';
const E2E_DIRECTORY = 'e2e/';

export async function runRelatedTests(
  paths: readonly string[],
  cwd: string,
  skips: readonly TestSkip[],
  workers: number,
): Promise<number> {
  const tests = readRelatedTests(paths, cwd);

  if (tests.length === 0) {
    process.stdout.write('run-related-tests: no related tests\n');

    return 0;
  }

  let exitCode = 0;

  for (const run of planTestRuns(tests, skips)) {
    for (const skip of run.skips) {
      process.stdout.write(
        `run-related-tests: skips "${skip.test}" in ${skip.file} (${skip.issue})\n`,
      );
    }

    // the test script passes a bare --parallel, and bun takes the last value
    const child = Bun.spawn(['bun', 'run', 'test', ...run.args, `--parallel=${workers}`], {
      cwd,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });

    const runExitCode = await child.exited;

    if (exitCode === 0) {
      exitCode = runExitCode;
    }
  }

  return exitCode;
}

if (import.meta.main) {
  const skips = loadTestSkips(join(import.meta.dir, 'pre-push-test-skips.json'));
  const workers = pickTestWorkers({ cpus: availableParallelism(), memoryBytes: totalmem() });

  const exitCode = await runRelatedTests(process.argv.slice(2), process.cwd(), skips, workers);

  process.exit(exitCode);
}
