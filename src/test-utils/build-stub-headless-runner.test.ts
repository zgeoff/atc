import { expect, test } from 'bun:test';
import { buildStubHeadlessRunner } from './build-stub-headless-runner';

test('it records each run with its request as still going', () => {
  const stub = buildStubHeadlessRunner();
  const hooks = { onOutput: () => {}, onDone: () => {}, onNeedsYou: () => {} };

  stub.runner({ cwd: '/work/a', prompt: 'first' }, hooks);
  stub.runner({ cwd: '/work/b', prompt: 'second' }, hooks);

  expect(stub.runs).toStrictEqual([
    { request: { cwd: '/work/a', prompt: 'first' }, stopped: false },
    { request: { cwd: '/work/b', prompt: 'second' }, stopped: false },
  ]);
});

test('it marks only the run the daemon stops as stopped', () => {
  const stub = buildStubHeadlessRunner();
  const hooks = { onOutput: () => {}, onDone: () => {}, onNeedsYou: () => {} };

  stub.runner({ cwd: '/work/a', prompt: 'first' }, hooks);
  stub.runner({ cwd: '/work/b', prompt: 'second' }, hooks).stop();

  expect(stub.runs.map((run) => run.stopped)).toStrictEqual([false, true]);
});

test('it emits nothing through the run hooks', () => {
  const stub = buildStubHeadlessRunner();
  const emitted: string[] = [];

  stub.runner(
    { cwd: '/work/a', prompt: 'first' },
    {
      onOutput: (text) => {
        emitted.push(`output ${text}`);
      },
      onDone: (result) => {
        emitted.push(`done ${result}`);
      },
      onNeedsYou: (msg) => {
        emitted.push(`needs-you ${msg}`);
      },
    },
  );

  expect(emitted).toBeEmpty();
});
