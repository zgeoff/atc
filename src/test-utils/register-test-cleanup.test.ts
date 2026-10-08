import { expect, onTestFinished, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';

test('it runs the release once the test finishes', () => {
  const runs: string[] = [];

  registerTestCleanup(() => {
    runs.push('released');
  });

  expect(runs).toStrictEqual([]);

  onTestFinished(() => {
    expect(runs).toStrictEqual(['released']);
  });
});

test('it runs a release the test already called no second time', () => {
  const runs: string[] = [];

  const release = registerTestCleanup(() => {
    runs.push('released');
  });

  release();

  onTestFinished(() => {
    expect(runs).toStrictEqual(['released']);
  });
});

test('it returns what the first call returned to every later call', () => {
  const release = registerTestCleanup(() => Promise.resolve('stopped'));
  const first = release();

  expect(release()).toBe(first);
  expect(first).resolves.toBe('stopped');
});

test('it waits for an asynchronous release before the next hook runs', () => {
  const runs: string[] = [];

  registerTestCleanup(async () => {
    await Promise.resolve();

    runs.push('released');
  });

  onTestFinished(() => {
    expect(runs).toStrictEqual(['released']);
  });
});

test('it refuses to register outside a test', () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      "import { registerTestCleanup } from './register-test-cleanup.ts'; registerTestCleanup(() => {});",
    ],
    { cwd: import.meta.dir },
  );

  expect(result.stderr.toString()).toInclude('outside of the test runner');
});

test('it releases what one test registered last first', () => {
  const runs: string[] = [];

  registerTestCleanup(() => {
    runs.push('first');
  });

  registerTestCleanup(() => {
    runs.push('second');
  });

  onTestFinished(() => {
    expect(runs).toStrictEqual(['second', 'first']);
  });
});

test('it runs every release though some throw, then rethrows them together', () => {
  const tmp = setupTempDir('atc-register-test-cleanup-');
  const log = join(tmp.dir, 'releases.log');
  const fixture = join(tmp.dir, 'releases.test.ts');

  writeFileSync(
    fixture,
    `import { test } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { registerTestCleanup } from ${JSON.stringify(join(import.meta.dir, 'register-test-cleanup.ts'))};

test('releases', () => {
  registerTestCleanup(() => appendFileSync(${JSON.stringify(log)}, 'first\\n'));
  registerTestCleanup(() => {
    throw new Error('second release failed');
  });
  registerTestCleanup(() => appendFileSync(${JSON.stringify(log)}, 'third\\n'));
  registerTestCleanup(() => {
    throw new Error('fourth release failed');
  });
});
`,
  );

  const result = Bun.spawnSync([process.execPath, 'test', fixture], { cwd: tmp.dir });

  expect(result.exitCode).toBe(1);
  expect(readFileSync(log, 'utf8')).toBe('third\nfirst\n');
  expect(result.stderr.toString()).toInclude('error: fourth release failed');
  expect(result.stderr.toString()).toInclude('error: second release failed');
});

test('it rethrows the one failure itself when a single release throws', () => {
  const tmp = setupTempDir('atc-register-test-cleanup-');
  const log = join(tmp.dir, 'releases.log');
  const fixture = join(tmp.dir, 'releases.test.ts');

  writeFileSync(
    fixture,
    `import { test } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { registerTestCleanup } from ${JSON.stringify(join(import.meta.dir, 'register-test-cleanup.ts'))};

test('releases', () => {
  registerTestCleanup(() => appendFileSync(${JSON.stringify(log)}, 'first\\n'));
  registerTestCleanup(() => {
    throw new Error('second release failed');
  });
});
`,
  );

  const result = Bun.spawnSync([process.execPath, 'test', fixture], { cwd: tmp.dir });

  expect(result.exitCode).toBe(1);
  expect(readFileSync(log, 'utf8')).toBe('first\n');
  expect(result.stderr.toString()).toInclude('error: second release failed');
  expect(result.stderr.toString()).not.toInclude('more than one test cleanup failed');
});
