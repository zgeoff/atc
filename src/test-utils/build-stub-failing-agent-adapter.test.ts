import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildStubFailingAgentAdapter } from './build-stub-failing-agent-adapter';
import { setupTempDir } from './setup-temp-dir';

test('it plans the first spawn with the first plan', () => {
  const stub = buildStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 1,
    readyFile: null,
  });

  expect(stub.adapter.planSpawn({ prompt: '', resume: false })).toStrictEqual({
    bin: 'first',
    args: [],
  });
});

test('it plans every spawn after the first with the later plan', () => {
  const stub = buildStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 1,
    readyFile: null,
  });

  stub.adapter.planSpawn({ prompt: '', resume: false });
  stub.adapter.planSpawn({ prompt: '', resume: false });

  expect(stub.adapter.planSpawn({ prompt: '', resume: false })).toStrictEqual({
    bin: 'later',
    args: [],
  });
});

test('it counts the spawns it planned', () => {
  const stub = buildStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 1,
    readyFile: null,
  });

  stub.adapter.planSpawn({ prompt: '', resume: false });
  stub.adapter.planSpawn({ prompt: '', resume: false });

  expect(stub.countPlans()).toBe(2);
});

test('it finds no headless runner before the first spawn is planned', () => {
  const stub = buildStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 1,
    readyFile: null,
  });

  expect(stub.adapter.headlessRunner).toBeNull();
});

test('it throws from as many headless runner reads as the config holds once the first spawn is planned, then finds none', () => {
  const stub = buildStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 2,
    readyFile: null,
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

test('it fails the first read only once another process has written the ready file', () => {
  using tmp = setupTempDir('atc-failing-adapter-');

  const readyFile = join(tmp.dir, 'ready');

  const stub = buildStubFailingAgentAdapter({
    firstPlan: { bin: 'first', args: [] },
    laterPlan: { bin: 'later', args: [] },
    failedReads: 1,
    readyFile,
  });

  stub.adapter.planSpawn({ prompt: '', resume: false });
  Bun.spawn(['touch', readyFile]);

  expect(() => stub.adapter.headlessRunner).toThrowWithMessage(
    Error,
    'adapter failed after the process started',
  );
});
