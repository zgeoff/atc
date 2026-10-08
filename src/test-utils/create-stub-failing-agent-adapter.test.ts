import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createStubFailingAgentAdapter } from './create-stub-failing-agent-adapter';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  const tmp = setupTempDir('atc-failing-adapter-');

  return { dir: tmp.dir };
}

test('it plans the first spawn with the first plan', async () => {
  const stub = await createStubFailingAgentAdapter({
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

test('it plans every spawn after the first with the later plan', async () => {
  const stub = await createStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 1,
    ready: null,
  });

  stub.adapter.planSpawn({ prompt: '', resume: false });

  const plans = [
    stub.adapter.planSpawn({ prompt: '', resume: false }),
    stub.adapter.planSpawn({ prompt: '', resume: false }),
  ];

  expect(plans).toStrictEqual([
    { bin: 'later', args: [] },
    { bin: 'later', args: [] },
  ]);
});

test('it counts the spawns it planned', async () => {
  const stub = await createStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 1,
    ready: null,
  });

  stub.adapter.planSpawn({ prompt: '', resume: false });
  stub.adapter.planSpawn({ prompt: '', resume: false });

  expect(stub.countPlans()).toBe(2);
});

test('it finds no headless runner before the first spawn is planned', async () => {
  const stub = await createStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 1,
    ready: null,
  });

  expect(stub.adapter.headlessRunner).toBeNull();
});

test('it throws from the first headless runner read once the first spawn is planned', async () => {
  const stub = await createStubFailingAgentAdapter({
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

test('it throws from the second headless runner read when the config holds two', async () => {
  const stub = await createStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 2,
    ready: null,
  });

  stub.adapter.planSpawn({ prompt: '', resume: false });

  // Spends the first failing read, whose throw another test checks.
  await Promise.allSettled([Promise.try(() => stub.adapter.headlessRunner)]);

  expect(() => stub.adapter.headlessRunner).toThrowWithMessage(
    Error,
    'adapter failed after the process started',
  );
});

test('it finds no headless runner once the failing reads the config holds are spent', async () => {
  const stub = await createStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 2,
    ready: null,
  });

  stub.adapter.planSpawn({ prompt: '', resume: false });

  const firstRead = Promise.try(() => stub.adapter.headlessRunner);
  const secondRead = Promise.try(() => stub.adapter.headlessRunner);

  await Promise.allSettled([firstRead, secondRead]);

  const runner = stub.adapter.headlessRunner;

  expect(firstRead).rejects.toThrowWithMessage(Error, 'adapter failed after the process started');
  expect(secondRead).rejects.toThrowWithMessage(Error, 'adapter failed after the process started');
  expect(runner).toBeNull();
});

test('it fails the first read only once a process has written its pid to the ready pipe', async () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'ready');

  const stub = await createStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 1,
    ready: { path, timeoutMs: 5000 },
  });

  stub.adapter.planSpawn({ prompt: '', resume: false });

  // The writer starts after the pipe exists and before the read, so the read
  // holds its pid only if it waited for the write.
  const writer = Bun.spawn(['bash', '-c', `echo $$ > '${path}'`]);

  registerTestCleanup(() => {
    writer.kill();
  });

  expect(() => stub.adapter.headlessRunner).toThrowWithMessage(
    Error,
    'adapter failed after the process started',
  );

  expect(stub.getReadyPID()).toBe(writer.pid);
});

test('it throws from the first read when no process writes the ready pipe in time', async () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'ready');

  const stub = await createStubFailingAgentAdapter({
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

test('it refuses to return a ready pid before any process has written one', async () => {
  const stub = await createStubFailingAgentAdapter({
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
