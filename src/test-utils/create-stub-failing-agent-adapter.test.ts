import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createStubFailingAgentAdapter } from './create-stub-failing-agent-adapter';
import { setupTempDir } from './setup-temp-dir';

test('it plans the first spawn with the first plan', () => {
  const stub = createStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 1,
    ready: null,
  });

  expect(stub.adapter.planSpawn({ prompt: '', resume: false })).toStrictEqual({
    bin: 'first',
    args: [],
  });
});

test('it plans every spawn after the first with the later plan', () => {
  const stub = createStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 1,
    ready: null,
  });

  stub.adapter.planSpawn({ prompt: '', resume: false });
  stub.adapter.planSpawn({ prompt: '', resume: false });

  expect(stub.adapter.planSpawn({ prompt: '', resume: false })).toStrictEqual({
    bin: 'later',
    args: [],
  });
});

test('it counts the spawns it planned', () => {
  const stub = createStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 1,
    ready: null,
  });

  stub.adapter.planSpawn({ prompt: '', resume: false });
  stub.adapter.planSpawn({ prompt: '', resume: false });

  expect(stub.countPlans()).toBe(2);
});

test('it finds no headless runner before the first spawn is planned', () => {
  const stub = createStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 1,
    ready: null,
  });

  expect(stub.adapter.headlessRunner).toBeNull();
});

test('it throws from the first headless runner read once the first spawn is planned', () => {
  const stub = createStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 2,
    ready: null,
  });

  stub.adapter.planSpawn({ prompt: '', resume: false });

  expect(() => stub.adapter.headlessRunner).toThrowWithMessage(
    Error,
    'adapter failed after the process started',
  );
});

test('it throws from as many headless runner reads as the config holds, then finds none', () => {
  const stub = createStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 2,
    ready: null,
  });

  stub.adapter.planSpawn({ prompt: '', resume: false });

  expect(() => stub.adapter.headlessRunner).toThrowWithMessage(
    Error,
    'adapter failed after the process started',
  );

  expect(() => stub.adapter.headlessRunner).toThrowWithMessage(
    Error,
    'adapter failed after the process started',
  );

  expect(stub.adapter.headlessRunner).toBeNull();
});

test('it fails the first read only once a process has written its pid to the ready pipe', () => {
  using tmp = setupTempDir('atc-failing-adapter-');

  const path = join(tmp.dir, 'ready');

  const stub = createStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 1,
    ready: { path, timeoutMs: 5000 },
  });

  stub.adapter.planSpawn({ prompt: '', resume: false });

  // The writer starts after the pipe exists and before the read, so the read
  // holds its pid only if it waited for the write.
  const writer = Bun.spawn(['bash', '-c', `echo $$ > '${path}'`]);

  expect(() => stub.adapter.headlessRunner).toThrowWithMessage(
    Error,
    'adapter failed after the process started',
  );

  expect(stub.getReadyPID()).toBe(writer.pid);
});

test('it throws from the first read when no process writes the ready pipe in time', () => {
  using tmp = setupTempDir('atc-failing-adapter-');

  const path = join(tmp.dir, 'ready');

  const stub = createStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 1,
    ready: { path, timeoutMs: 1 },
  });

  stub.adapter.planSpawn({ prompt: '', resume: false });

  expect(() => stub.adapter.headlessRunner).toThrowWithMessage(
    Error,
    `no process wrote ${path} within 1ms`,
  );
});

test('it refuses to return a ready pid before any process has written one', () => {
  const stub = createStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 1,
    ready: null,
  });

  expect(() => stub.getReadyPID()).toThrowWithMessage(
    Error,
    'no process has written its pid to the ready pipe',
  );
});
