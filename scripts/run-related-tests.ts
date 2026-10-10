// Runs the tests that sit beside the given files: a test file runs itself,
// and a source file runs its sibling test file. Prints a line and exits 0
// when none of the files has a test.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Returns the test files related to the given paths, in order and without
 * duplicates. A path ending in .test.ts selects itself when it exists; any
 * other .ts path (declaration files excluded) selects its sibling .test.ts
 * when that exists. Paths resolve against cwd.
 */
export function collectRelatedTests(paths: readonly string[], cwd: string): string[] {
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

  return [...selected];
}

/**
 * Runs the repo's test script over the tests related to the given paths and
 * returns its exit code, or 0 after printing a note when there are none.
 */
export function runRelatedTests(paths: readonly string[], cwd: string): Promise<number> {
  const tests = collectRelatedTests(paths, cwd);

  if (tests.length === 0) {
    process.stdout.write('run-related-tests: no related tests\n');

    return Promise.resolve(0);
  }

  const run = Bun.spawn(['bun', 'run', 'test', ...tests], {
    cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  return run.exited;
}

if (import.meta.main) {
  const exitCode = await runRelatedTests(process.argv.slice(2), process.cwd());

  process.exit(exitCode);
}
