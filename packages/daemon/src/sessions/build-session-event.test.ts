import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildMockAgentAdapter } from '@atc/plugin-api/test-utils/build-mock-agent-adapter';
import { createStateStore } from '@atc/store';
import { toSessionID } from '@atcx/contract';
import { registerTestCleanup } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';
import { buildMockSession } from '../test-utils/build-mock-session';
import { buildSessionEvent } from './build-session-event';
import { createSessionManager } from './create-session-manager';

async function setupTest() {
  const temporaryDirectory = createTempDir('atc-daemon-events-');

  const store = await createStateStore(join(temporaryDirectory.path, 'state.db'));

  registerTestCleanup(() => store.stop());

  const manager = createSessionManager({
    fallback: buildMockAgentAdapter(),
    store,
    statusPath: join(temporaryDirectory.path, 'status.json'),
    adapters: [],
  });

  registerTestCleanup(() => {
    manager.detachAll();
  });

  return { manager };
}

test('it builds nothing for a SessionState notification whose id has no descriptor', async () => {
  const ctx = await setupTest();

  const event = buildSessionEvent(
    ctx.manager,
    'state',
    buildMockSession({ id: toSessionID('ghost-session') }),
  );

  expect(event).toBeNull();
});

test('it builds nothing for a SessionAdded notification whose id has no descriptor', async () => {
  const ctx = await setupTest();

  const event = buildSessionEvent(
    ctx.manager,
    'added',
    buildMockSession({ id: toSessionID('ghost-session') }),
  );

  expect(event).toBeNull();
});
