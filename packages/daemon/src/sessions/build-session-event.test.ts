import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createStateStore } from '@atc/store';
import { buildMockAgentAdapter, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import { buildMockSession } from '../testing/build-mock-session';
import { buildSessionEvent } from './build-session-event';
import { createSessionManager } from './create-session-manager';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-daemon-events-');

  const store = await createStateStore(join(temporaryDirectory.path, 'state.db'));

  registerTestCleanup(() => store.stop());

  const manager = createSessionManager(
    buildMockAgentAdapter(),
    store,
    join(temporaryDirectory.path, 'status.json'),
    [],
  );

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
