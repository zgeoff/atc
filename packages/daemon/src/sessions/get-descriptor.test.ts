import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createStateStore } from '@atc/store';
import { createMigratedStateDB } from '@atc/store/test-utils/create-migrated-state-db';
import { toSessionID } from '@atcx/contract';
import { registerTestCleanup } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';
import { buildMockExecutionTarget } from '../test-utils/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../test-utils/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../test-utils/build-stub-memory-provider';
import { createSessionManager } from './create-session-manager';
import { getDescriptor } from './get-descriptor';

async function setupTest() {
  const temporaryDirectory = createTempDir('atc-get-descriptor-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const manager = createSessionManager({
    fallback: null,
    store,
    statusPath: join(temporaryDirectory.path, 'status.json'),
    adapters: [buildStubHarnessAdapter()],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
    ],
  });

  registerTestCleanup(() => {
    manager.detachAll();
  });

  return { directory: temporaryDirectory.path, manager };
}

test('it gets the descriptor of a session the manager holds', async () => {
  const ctx = await setupTest();

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  expect(getDescriptor(ctx.manager, session.id)).toMatchObject({ id: session.id, name: 'worker' });
});

test('it throws for a session the manager does not hold', async () => {
  const ctx = await setupTest();

  expect(() => getDescriptor(ctx.manager, toSessionID('s-gone'))).toThrowWithMessage(
    Error,
    /descriptor for unknown session s-gone/u,
  );
});
