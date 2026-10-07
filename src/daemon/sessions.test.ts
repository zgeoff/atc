import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { buildStubHostProvider } from '../test-utils/build-stub-host-provider';
import { createMigratedStateDB } from '../test-utils/create-migrated-state-db';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { waitFor } from '../test-utils/wait-for';
import { buildTargetIdentity } from './build-target-identity';
import { LocalPTYProvider } from './local-pty-provider';
import { SessionManager } from './sessions';

// The fixed parts every session manager test shares: a real state store, a
// recorder of logged lines, and two target providers: `local` on this
// machine's terminals, and `box`, whose hosts can sleep and be destroyed.
// `defer` runs a teardown before the store and the providers go, so a
// manager the test builds detaches first.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-sessions-'));
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  stack.defer(() => store.stop());

  const local = new LocalPTYProvider();

  const box = buildStubHostProvider();

  stack.defer(() => {
    local.dispose();
    box.dispose();
  });

  const lines: string[] = [];
  const owned = stack.move();

  return {
    dir: tmp.dir,
    dbPath,
    statusPath: join(tmp.dir, 'status.json'),
    store,
    local,
    box,
    lines,
    log: (line: string) => {
      lines.push(line);
    },
    defer: (teardown: () => void) => {
      owned.defer(teardown);
    },
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it restores an entry whose agent id is registered as waiting for its terminal', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const session = mgr.restore({
    sessionID: toSessionID('s-c-1'),
    name: 'claude work',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-1'),
    agent: 'claude',
  });

  expect(session.lastMsg).toBe('waiting to restore');
});

test('it restores an entry whose agent id is unregistered with a message that the adapter is missing', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const session = mgr.restore({
    sessionID: toSessionID('s-z-1'),
    name: 'glm work',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('z-1'),
    agent: 'zai',
  });

  expect(session.lastMsg).toBe("no adapter for 'zai'");
});

test('it never revives a restored entry whose agent id is unregistered as another agent', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const session = mgr.restore({
    sessionID: toSessionID('s-z-1'),
    name: 'glm work',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('z-1'),
    agent: 'zai',
  });

  const adopted = await mgr.adoptTerminal(session.id, 80, 24);

  expect(adopted).toBeNull();
});

test('it resolves an agent id to the registered adapter that declares it', async () => {
  const gateway = buildMockAgentAdapter({ id: 'zai' });

  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [gateway],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  expect(mgr.findAdapter('zai')).toBe(gateway);
});

test('it resolves the fallback adapter by its own id, not by another registered one', async () => {
  const fallback = buildMockAgentAdapter();

  await using ctx = await setupTest();

  const mgr = new SessionManager(
    fallback,
    ctx.store,
    ctx.statusPath,
    [buildMockAgentAdapter({ id: 'zai' })],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  expect(mgr.findAdapter('claude')).toBe(fallback);
});

test('it resolves an agent id no adapter declares to no adapter', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [buildMockAgentAdapter({ id: 'zai' })],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  expect(mgr.findAdapter('grok')).toBeNull();
});

test('it reports no screen detector when no registered adapter provides one', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [buildMockAgentAdapter({ id: 'zai' })],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  expect(mgr.hasScreenDetector).toBeFalse();
});

test('it reports a screen detector when a registered adapter provides one', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [buildMockAgentAdapter({ id: 'zai', screenDetector: { detectAttention: () => null } })],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  expect(mgr.hasScreenDetector).toBeTrue();
});

test('it links a restored sub-session to the parent already registered under its session id', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const parent = mgr.restore({
    sessionID: toSessionID('s-c-parent'),
    name: 'wrangler',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
  });

  const child = mgr.restore({
    sessionID: toSessionID('s-c-child'),
    name: 'worker',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-child'),
    agent: 'claude',
    parent: toSessionID('s-c-parent'),
  });

  expect(child.parent).toBe(parent.id);
});

test('it restores a sub-session whose parent is absent as a top-level session', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const child = mgr.restore({
    sessionID: toSessionID('s-c-child'),
    name: 'worker',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-child'),
    agent: 'claude',
    parent: toSessionID('s-c-gone'),
  });

  expect(child.parent).toBeNull();
});

test('it persists a sub-session link by the parent atc session id', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const parent = mgr.restore({
    sessionID: toSessionID('s-c-parent'),
    name: 'wrangler',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
  });

  const child = await mgr.spawn(
    ctx.dir,
    'worker',
    '',
    80,
    24,
    toAgentSessionID('c-child'),
    'user',
    'claude',
    parent.id,
  );

  await mgr.writeFleet();

  const stored = await ctx.store.loadFleet();

  expect(stored).toStrictEqual([
    {
      sessionID: toSessionID('s-c-parent'),
      name: 'wrangler',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
      target: 'local',
      targetIdentity: buildTargetIdentity('local-pty', {}),
      lastAttachedAt: expect.toBeNumber(),
    },
    {
      sessionID: child.id,
      name: 'worker',
      cwd: ctx.dir,
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      target: 'local',
      targetIdentity: buildTargetIdentity('local-pty', {}),
      lastAttachedAt: expect.toBeNumber(),
      parent: parent.id,
    },
  ]);
});

test('it stores a sub-session under a sub-session that resumed their parent agent session', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const parent = mgr.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-parent'),
      name: 'wrangler',
      cwd: ctx.dir,
      agentSessionID: toAgentSessionID('c-parent'),
      exited: true,
    }),
  );

  const child = await mgr.spawn(
    ctx.dir,
    'worker',
    '',
    80,
    24,
    toAgentSessionID('c-child'),
    'user',
    'claude',
    parent.id,
  );

  // Spawned under the session whose agent session it resumes, so the row
  // it replaces is its own parent.
  const resumed = await mgr.spawn(
    ctx.dir,
    'wrangler',
    '',
    80,
    24,
    toAgentSessionID('c-parent'),
    'user',
    'claude',
    parent.id,
  );

  await mgr.writeFleet();

  const stored = await ctx.store.loadFleet();

  expect(stored.map((entry) => [entry.sessionID, entry.parent])).toStrictEqual([
    [child.id, resumed.id],
    [resumed.id, undefined],
  ]);
});

test('it refuses to pin a sub-session and leaves it unpinned', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  mgr.restore({
    sessionID: toSessionID('s-c-parent'),
    name: 'wrangler',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
  });

  const child = mgr.restore({
    sessionID: toSessionID('s-c-child'),
    name: 'worker',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-child'),
    agent: 'claude',
    parent: toSessionID('s-c-parent'),
  });

  const pinned = mgr.updateSession(child.id, undefined, true);

  expect({ pinned, isPinned: child.pinned }).toStrictEqual({
    pinned: 'child_pin',
    isPinned: false,
  });
});

test('it pins a parent that has a sub-session', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const parent = mgr.restore({
    sessionID: toSessionID('s-c-parent'),
    name: 'wrangler',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
  });

  mgr.restore({
    sessionID: toSessionID('s-c-child'),
    name: 'worker',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-child'),
    agent: 'claude',
    parent: toSessionID('s-c-parent'),
  });

  expect(mgr.updateSession(parent.id, undefined, true)).toBeTrue();
});

test('it kills a live sub-session along with its parent', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const parent = await mgr.spawn(ctx.dir, 'wrangler', '', 80, 24, false, 'user', 'claude');
  const child = await mgr.spawn(ctx.dir, 'worker', '', 80, 24, false, 'user', 'claude', parent.id);

  await mgr.kill(parent.id);

  expect({ parent: parent.state, child: child.state, link: child.parent }).toStrictEqual({
    parent: 'exited',
    child: 'exited',
    link: parent.id,
  });
});

test('it forgets a dead parent with its dead sub-sessions and promotes the live ones', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const parent = mgr.restore({
    sessionID: toSessionID('s-c-parent'),
    name: 'wrangler',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
    exited: true,
  });

  mgr.restore({
    sessionID: toSessionID('s-c-dead'),
    name: 'dead worker',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-dead'),
    agent: 'claude',
    exited: true,
    parent: toSessionID('s-c-parent'),
  });

  const live = await mgr.spawn(
    ctx.dir,
    'live worker',
    '',
    80,
    24,
    false,
    'user',
    'claude',
    parent.id,
  );

  await mgr.kill(parent.id);

  expect(mgr.sessions.map((s) => ({ id: s.id, parent: s.parent }))).toStrictEqual([
    { id: live.id, parent: null },
  ]);
});

test('it keeps an exited sub-session on a host-destroying target when a second kill forgets its dead local parent', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  mgr.restore({
    sessionID: toSessionID('s-parent'),
    name: 'wrangler',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
    exited: true,
    target: 'local',
    targetIdentity: buildTargetIdentity('local-pty', {}),
  });

  const remote = mgr.restore({
    sessionID: toSessionID('s-remote'),
    name: 'remote worker',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-remote'),
    agent: 'claude',
    exited: true,
    parent: toSessionID('s-parent'),
    target: 'box',
    targetIdentity: 'imp-like:test',
  });

  await mgr.kill(toSessionID('s-parent'));

  expect(mgr.sessions.map((s) => ({ id: s.id, parent: s.parent }))).toStrictEqual([
    { id: remote.id, parent: null },
  ]);
});

test("it refuses to forget a session kept asleep inside its parent's host and keeps its record", async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  mgr.restore({
    sessionID: toSessionID('s-parent'),
    name: 'wrangler',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
    exited: true,
    desired: 'sleep',
    target: 'box',
    targetIdentity: 'imp-like:test',
  });

  mgr.restore({
    sessionID: toSessionID('s-guest'),
    name: 'guest',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-guest'),
    agent: 'claude',
    exited: true,
    desired: 'sleep',
    parent: toSessionID('s-parent'),
    hostKey: toSessionID('s-parent'),
    target: 'box',
    targetIdentity: 'imp-like:test',
  });

  const forgotten = mgr.forget(toSessionID('s-guest'));

  expect(forgotten).rejects.toMatchObject({
    code: 'unsupported_operation',
    data: { problem: 'host_asleep', host: 's-parent' },
  });

  expect(mgr.sessions.map((s) => s.id)).toStrictEqual([
    toSessionID('s-parent'),
    toSessionID('s-guest'),
  ]);
});

test("it forgets an exited session on its parent's host while that host is not asleep", async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  mgr.restore({
    sessionID: toSessionID('s-parent'),
    name: 'wrangler',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
    exited: true,
    target: 'box',
    targetIdentity: 'imp-like:test',
  });

  mgr.restore({
    sessionID: toSessionID('s-guest'),
    name: 'guest',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-guest'),
    agent: 'claude',
    exited: true,
    parent: toSessionID('s-parent'),
    hostKey: toSessionID('s-parent'),
    target: 'box',
    targetIdentity: 'imp-like:test',
  });

  const destroyed = await mgr.forget(toSessionID('s-guest'));

  expect({ destroyed, ids: mgr.sessions.map((s) => s.id) }).toStrictEqual({
    destroyed: false,
    ids: [toSessionID('s-parent')],
  });
});

test("it keeps a finished turn's last message as the session result", async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [
      buildMockAgentAdapter({
        normalizeHook: () => ({ kind: 'turn-done', result: 'all green' }),
      }),
    ],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const s = await mgr.spawn(ctx.dir, 'worker', 'go', 80, 24, toAgentSessionID('c-1'));

  mgr.applyHook({ atcId: s.id, event: 'Stop', payload: {} });

  await mgr.writeFleet();

  const stored = await ctx.store.loadFleet();

  expect(stored).toStrictEqual([
    {
      sessionID: s.id,
      name: 'worker',
      cwd: ctx.dir,
      agentSessionID: toAgentSessionID('c-1'),
      agent: 'claude',
      target: 'local',
      targetIdentity: buildTargetIdentity('local-pty', {}),
      lastAttachedAt: expect.toBeNumber(),
      prompt: 'go',
      result: 'all green',
    },
  ]);
});

test('it truncates a stored result past 16 KiB', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [
      buildMockAgentAdapter({
        normalizeHook: () => ({ kind: 'turn-done', result: 'x'.repeat(20_000) }),
      }),
    ],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const s = await mgr.spawn(ctx.dir, 'worker', 'go', 80, 24, toAgentSessionID('c-1'));

  mgr.applyHook({ atcId: s.id, event: 'Stop', payload: {} });

  await mgr.writeFleet();

  const [stored] = await ctx.store.loadFleet();

  expect(stored?.result).toBe(`${'x'.repeat(16_381)}…`);
});

test('it persists the transcript path its hooks report', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [
      buildMockAgentAdapter({
        normalizeHook: () => ({
          kind: 'started',
          agentSessionID: toAgentSessionID('c-2'),
          transcriptSource: '/t/c-2.jsonl',
        }),
      }),
    ],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const s = await mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  mgr.applyHook({ atcId: s.id, event: 'SessionStart', payload: {} });

  await mgr.writeFleet();

  const stored = await ctx.store.loadFleet();

  expect(stored).toStrictEqual([
    {
      sessionID: s.id,
      name: 'worker',
      cwd: ctx.dir,
      agentSessionID: toAgentSessionID('c-2'),
      agent: 'claude',
      target: 'local',
      targetIdentity: buildTargetIdentity('local-pty', {}),
      lastAttachedAt: expect.toBeNumber(),
      transcriptPath: '/t/c-2.jsonl',
    },
  ]);
});

test("it restores an entry's prompt, result, and transcript path onto the session", async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const session = mgr.restore({
    sessionID: toSessionID('s-c-1'),
    name: 'wrangler',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-1'),
    agent: 'claude',
    prompt: 'go',
    result: 'done',
    transcriptPath: '/t.jsonl',
  });

  expect(session).toMatchObject({ prompt: 'go', result: 'done', transcriptPath: '/t.jsonl' });
  expect(session.transcriptSource).toBeUndefined();
});

test('it keeps a crashed sibling restorable as live when another session finishes a turn', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [
      buildMockAgentAdapter({
        normalizeHook: () => ({ kind: 'turn-done', result: 'all green' }),
      }),
    ],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const finisher = await mgr.spawn(ctx.dir, 'finisher', 'go', 80, 24, toAgentSessionID('c-1'));
  const crasher = await mgr.spawn(ctx.dir, 'crasher', 'go', 80, 24, toAgentSessionID('c-2'));

  await mgr.writeFleet();

  crasher.pty?.kill();

  await waitFor(() => {
    expect(crasher.state).toBe('exited');
  });

  mgr.applyHook({ atcId: finisher.id, event: 'Stop', payload: {} });

  await waitFor(async () => {
    const stored = await ctx.store.loadFleet();

    expect(stored).toStrictEqual([
      {
        sessionID: finisher.id,
        name: 'finisher',
        cwd: ctx.dir,
        agentSessionID: toAgentSessionID('c-1'),
        agent: 'claude',
        target: 'local',
        targetIdentity: buildTargetIdentity('local-pty', {}),
        lastAttachedAt: expect.toBeNumber(),
        prompt: 'go',
        result: 'all green',
      },
      {
        sessionID: crasher.id,
        name: 'crasher',
        cwd: ctx.dir,
        agentSessionID: toAgentSessionID('c-2'),
        agent: 'claude',
        target: 'local',
        targetIdentity: buildTargetIdentity('local-pty', {}),
        lastAttachedAt: expect.toBeNumber(),
        prompt: 'go',
      },
    ]);
  });
});

test('it restores an entry under the session id its row holds', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const session = mgr.restore({
    sessionID: toSessionID('7d3f0c1e-2b4a-4c5d-8e9f-0a1b2c3d4e5f'),
    name: 'claude work',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-1'),
    agent: 'claude',
  });

  expect(session.id).toBe(toSessionID('7d3f0c1e-2b4a-4c5d-8e9f-0a1b2c3d4e5f'));
});

test('it restores an entry with no agent session id as exited', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const session = mgr.restore({
    sessionID: toSessionID('s-booting'),
    name: 'booting',
    cwd: '/work/proj',
    agent: 'claude',
  });

  expect({ state: session.state, lastMsg: session.lastMsg }).toStrictEqual({
    state: 'exited',
    lastMsg: 'nothing to resume',
  });
});

test('it persists a session the agent has not yet given a session id', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const s = await mgr.spawn(ctx.dir, 'booting', '', 80, 24);

  await mgr.writeFleet();

  const stored = await ctx.store.loadFleet();

  expect(stored).toStrictEqual([
    {
      sessionID: s.id,
      name: 'booting',
      cwd: ctx.dir,
      agent: 'claude',
      target: 'local',
      targetIdentity: buildTargetIdentity('local-pty', {}),
      lastAttachedAt: expect.toBeNumber(),
    },
  ]);
});

test('it logs a background fleet write that fails and keeps the change in memory', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const session = mgr.restore({
    sessionID: toSessionID('s-1'),
    name: 'work',
    cwd: '/work/proj',
    agent: 'claude',
  });

  // Another connection drops the table, so the store's write fails in SQLite.
  {
    using db = new Database(ctx.dbPath);

    db.run('DROP TABLE fleet');
  }

  mgr.updateSession(session.id, 'renamed');

  await waitFor(() => {
    expect(ctx.lines).toStrictEqual([
      'atc fleet write for session s-1 failed (internal): no such table: fleet',
    ]);
  });

  expect(session.name).toBe('renamed');
});

test('it logs a background row update that fails', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const session = mgr.restore({
    sessionID: toSessionID('s-1'),
    name: 'work',
    cwd: '/work/proj',
    agent: 'claude',
  });

  // Another connection drops the table, so the store's write fails in SQLite.
  {
    using db = new Database(ctx.dbPath);

    db.run('DROP TABLE fleet');
  }

  mgr.updateSurfaceState(session.id, 'done', 'finished', 'the result');

  await waitFor(() => {
    expect(ctx.lines).toStrictEqual([
      'atc fleet write for session s-1 failed (internal): no such table: fleet',
    ]);
  });
});

test('it logs nothing for a background fleet write refused as stale_epoch', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: ctx.box },
    ],
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

  const session = mgr.restore({
    sessionID: toSessionID('s-1'),
    name: 'work',
    cwd: '/work/proj',
    agent: 'claude',
  });

  // An owner row from a later ownership epoch, which this daemon's writes
  // may no longer replace.
  {
    using db = new Database(ctx.dbPath);

    db.run(
      'INSERT INTO session_owner (session_id, daemon_id, owner_epoch, updated_at) VALUES (?, ?, 2, 0)',
      ['s-1', ctx.store.daemonID],
    );
  }

  mgr.updateSession(session.id, 'renamed');

  // The store serves one write at a time, so this refusal settles only after
  // the background write's refusal has been handled.
  expect(mgr.writeFleet()).rejects.toMatchObject({ code: 'stale_epoch' });
  expect(ctx.lines).toStrictEqual([]);
});
