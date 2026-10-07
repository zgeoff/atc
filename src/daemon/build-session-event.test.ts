import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockSession } from '../test-utils/build-mock-session';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { buildSessionEvent } from './build-session-event';
import { SessionManager } from './sessions';

/**
 * A session manager over a real state store in a temp directory, holding
 * no sessions.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-daemon-events-'));

  const store = await StateStore.open(join(tmp.dir, 'state.db'));

  stack.use(store);

  const mgr = stack.use(
    new SessionManager(buildMockAgentAdapter(), store, join(tmp.dir, 'status.json'), []),
  );

  const owned = stack.move();

  return { mgr, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it builds nothing for a SessionState notification whose id has no descriptor', async () => {
  await using ctx = await setupTest();

  const event = buildSessionEvent(
    ctx.mgr,
    'state',
    buildMockSession({ id: toSessionID('ghost-session') }),
  );

  expect(event).toBeNull();
});

test('it builds nothing for a SessionAdded notification whose id has no descriptor', async () => {
  await using ctx = await setupTest();

  const event = buildSessionEvent(
    ctx.mgr,
    'added',
    buildMockSession({ id: toSessionID('ghost-session') }),
  );

  expect(event).toBeNull();
});
