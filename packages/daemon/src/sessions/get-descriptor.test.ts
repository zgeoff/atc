import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { toSessionID } from '@atc/core';
import { StateStore } from '@atc/store';
import { createMigratedStateDB } from '@atc/store/testing';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { getDescriptor } from './get-descriptor';
import { SessionManager } from './sessions';

// A session manager on one `local` target over the in-memory provider and
// a real state store.
async function setupTest() {
  const tmp = setupTempDir('atc-get-descriptor-');
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const mgr = new SessionManager(
    null,
    store,
    join(tmp.dir, 'status.json'),
    [buildStubHarnessAdapter()],
    [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
    ],
    [],
    {},
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  return { dir: tmp.dir, mgr };
}

test('it gets the descriptor of a session the manager holds', async () => {
  const ctx = await setupTest();
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  expect(getDescriptor(ctx.mgr, s.id)).toMatchObject({ id: s.id, name: 'worker' });
});

test('it throws for a session the manager does not hold', async () => {
  const ctx = await setupTest();

  expect(() => getDescriptor(ctx.mgr, toSessionID('s-gone'))).toThrowWithMessage(
    Error,
    /descriptor for unknown session s-gone/,
  );
});
