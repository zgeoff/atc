import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { toSessionID } from '@atc/core';
import { StateStore } from '@atc/store';
import { buildMockAgentAdapter, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { buildMockSession } from '../testing/build-mock-session';
import { buildSessionEvent } from './build-session-event';
import { SessionManager } from './sessions';

/**
 * A session manager over a real state store in a temp directory, holding
 * no sessions.
 */
async function setupTest() {
  const tmp = setupTempDir('atc-daemon-events-');

  const store = await StateStore.open(join(tmp.dir, 'state.db'));

  registerTestCleanup(() => store.stop());

  const mgr = new SessionManager(buildMockAgentAdapter(), store, join(tmp.dir, 'status.json'), []);

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  return { mgr };
}

test('it builds nothing for a SessionState notification whose id has no descriptor', async () => {
  const ctx = await setupTest();

  const event = buildSessionEvent(
    ctx.mgr,
    'state',
    buildMockSession({ id: toSessionID('ghost-session') }),
  );

  expect(event).toBeNull();
});

test('it builds nothing for a SessionAdded notification whose id has no descriptor', async () => {
  const ctx = await setupTest();

  const event = buildSessionEvent(
    ctx.mgr,
    'added',
    buildMockSession({ id: toSessionID('ghost-session') }),
  );

  expect(event).toBeNull();
});
