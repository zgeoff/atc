import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
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

  stack.defer(() => store.stop());

  const mgr = new SessionManager(buildMockAgentAdapter(), store, join(tmp.dir, 'status.json'), []);

  const owned = stack.move();

  return { mgr, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it builds nothing for a SessionState notification whose id has no descriptor', async () => {
  await using ctx = await setupTest();

  const event = buildSessionEvent(ctx.mgr, 'state', {
    id: toSessionID('ghost-session'),
    name: 'ghost',
    cwd: '/work/ghost',
    kind: 'pty',
    pty: null,
    state: 'exited',
    unread: false,
    lastMsg: '',
    agent: 'claude',
    pinned: false,
    lastAttachedAt: 1_700_000_000_000,
    repoRoot: '/work/ghost',
    namedBy: 'auto',
    createdAt: 1_700_000_000_000,
    parent: null,
    target: 'local',
    targetIdentity: 'local-pty:test',
    withheldEnv: [],
    desired: 'run',
    vm: 'none',
    attachment: 'local',
    suspended: false,
    hostKey: toSessionID('ghost-session'),
    bridgeEpoch: 0,
  });

  expect(event).toBeNull();
});

test('it builds nothing for a SessionAdded notification whose id has no descriptor', async () => {
  await using ctx = await setupTest();

  const event = buildSessionEvent(ctx.mgr, 'added', {
    id: toSessionID('ghost-session'),
    name: 'ghost',
    cwd: '/work/ghost',
    kind: 'pty',
    pty: null,
    state: 'exited',
    unread: false,
    lastMsg: '',
    agent: 'claude',
    pinned: false,
    lastAttachedAt: 1_700_000_000_000,
    repoRoot: '/work/ghost',
    namedBy: 'auto',
    createdAt: 1_700_000_000_000,
    parent: null,
    target: 'local',
    targetIdentity: 'local-pty:test',
    withheldEnv: [],
    desired: 'run',
    vm: 'none',
    attachment: 'local',
    suspended: false,
    hostKey: toSessionID('ghost-session'),
    bridgeEpoch: 0,
  });

  expect(event).toBeNull();
});
