import { expect, onTestFinished, test } from 'bun:test';
import { registerTestCleanup } from './register-test-cleanup';

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
