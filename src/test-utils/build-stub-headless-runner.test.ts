import { expect, mock, test } from 'bun:test';
import { buildStubHeadlessRunner } from './build-stub-headless-runner';

test('it records each run with its request and events as still going', () => {
  const stub = buildStubHeadlessRunner();
  const hooks = { onOutput: () => {}, onDone: () => {}, onNeedsYou: () => {} };

  stub.runner({ cwd: '/work/a', prompt: 'first' }, hooks);
  stub.runner({ cwd: '/work/b', prompt: 'second' }, hooks);

  expect(stub.runs).toStrictEqual([
    { request: { cwd: '/work/a', prompt: 'first' }, events: hooks, stopped: false },
    { request: { cwd: '/work/b', prompt: 'second' }, events: hooks, stopped: false },
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

test('it resolves a wait for a run the daemon starts later with that run', () => {
  const stub = buildStubHeadlessRunner();
  const events = { onOutput: mock(() => {}), onDone: mock(() => {}), onNeedsYou: mock(() => {}) };

  const started = stub.waitForRun(1);

  stub.runner({ cwd: '/work/a', prompt: 'first' }, events);
  stub.runner({ cwd: '/work/b', prompt: 'second' }, events);

  expect(started).resolves.toStrictEqual({
    request: { cwd: '/work/b', prompt: 'second' },
    events,
    stopped: false,
  });
});

test('it resolves a wait for a run the daemon already started with that run', () => {
  const stub = buildStubHeadlessRunner();
  const events = { onOutput: mock(() => {}), onDone: mock(() => {}), onNeedsYou: mock(() => {}) };

  stub.runner({ cwd: '/work/a', prompt: 'first' }, events);

  expect(stub.waitForRun(0)).resolves.toStrictEqual({
    request: { cwd: '/work/a', prompt: 'first' },
    events,
    stopped: false,
  });
});

test('it marks only the run the daemon stops as stopped', () => {
  const stub = buildStubHeadlessRunner();
  const events = { onOutput: mock(() => {}), onDone: mock(() => {}), onNeedsYou: mock(() => {}) };

  stub.runner({ cwd: '/work/a', prompt: 'first' }, events);
  stub.runner({ cwd: '/work/b', prompt: 'second' }, events).stop();

  expect(stub.runs.map((run) => run.stopped)).toStrictEqual([false, true]);
});

test('it resolves a wait for a run the daemon starts later with that run', () => {
  const stub = buildStubHeadlessRunner();
  const events = { onOutput: mock(() => {}), onDone: mock(() => {}), onNeedsYou: mock(() => {}) };
  const started = stub.waitForRun(1);

  stub.runner({ cwd: '/work/a', prompt: 'first' }, events);
  stub.runner({ cwd: '/work/b', prompt: 'second' }, events);

  expect(started).resolves.toStrictEqual({
    request: { cwd: '/work/b', prompt: 'second' },
    events,
    stopped: false,
  });
});

test('it resolves a wait for a run the daemon already started with that run', () => {
  const stub = buildStubHeadlessRunner();
  const events = { onOutput: mock(() => {}), onDone: mock(() => {}), onNeedsYou: mock(() => {}) };

  stub.runner({ cwd: '/work/a', prompt: 'first' }, events);

  expect(stub.waitForRun(0)).resolves.toStrictEqual({
    request: { cwd: '/work/a', prompt: 'first' },
    events,
    stopped: false,
  });
});
