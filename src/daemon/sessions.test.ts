import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { AgentAdapter } from '../agents/agent-adapter';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildStubHostProvider } from '../test-utils/build-stub-host-provider';
import { createMigratedStateDB } from '../test-utils/create-migrated-state-db';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { waitFor } from '../test-utils/wait-for';
import { buildTargetIdentity } from './build-target-identity';
import { LocalPTYProvider } from './local-pty-provider';
import { SessionManager } from './sessions';

interface SessionsTestConfig {
  // The adapter a session with no registered agent id falls back to.
  readonly adapter: AgentAdapter;

  // The adapters registered over and above the fallback.
  readonly adapters: readonly AgentAdapter[];
}

// A session manager over a real state store with the given adapters, every
// line it logs collected, and two targets: `local` on this machine's
// terminals, and `box`, whose hosts can sleep and be destroyed.
async function setupTest(config: SessionsTestConfig) {
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

  const mgr = new SessionManager(
    config.adapter,
    store,
    join(tmp.dir, 'status.json'),
    config.adapters,
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: box },
    ],
  );

  mgr.log = (line) => {
    lines.push(line);
  };

  stack.defer(() => {
    mgr.detachAll();
  });

  const owned = stack.move();

  return {
    dir: tmp.dir,
    dbPath,
    store,
    mgr,
    lines,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it restores an entry whose agent id is registered as waiting for its terminal', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [] });

  const session = ctx.mgr.restore({
    sessionID: toSessionID('s-c-1'),
    name: 'claude work',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-1'),
    agent: 'claude',
  });

  expect(session.lastMsg).toBe('waiting to restore');
});

test('it restores an entry whose agent id is unregistered with a message that the adapter is missing', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [] });

  const session = ctx.mgr.restore({
    sessionID: toSessionID('s-z-1'),
    name: 'glm work',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('z-1'),
    agent: 'zai',
  });

  expect(session.lastMsg).toBe("no adapter for 'zai'");
});

test('it never revives a restored entry whose agent id is unregistered as another agent', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [] });

  const session = ctx.mgr.restore({
    sessionID: toSessionID('s-z-1'),
    name: 'glm work',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('z-1'),
    agent: 'zai',
  });

  const adopted = await ctx.mgr.adoptTerminal(session.id, 80, 24);

  expect(adopted).toBeNull();
});

test('it resolves an agent id to the registered adapter that declares it', async () => {
  const gateway = buildMockAgentAdapter({ id: 'zai' });

  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [gateway] });

  expect(ctx.mgr.findAdapter('zai')).toBe(gateway);
});

test('it resolves the fallback adapter by its own id, not by another registered one', async () => {
  const fallback = buildMockAgentAdapter();

  await using ctx = await setupTest({
    adapter: fallback,
    adapters: [buildMockAgentAdapter({ id: 'zai' })],
  });

  expect(ctx.mgr.findAdapter('claude')).toBe(fallback);
});

test('it resolves an agent id no adapter declares to no adapter', async () => {
  await using ctx = await setupTest({
    adapter: buildMockAgentAdapter(),
    adapters: [buildMockAgentAdapter({ id: 'zai' })],
  });

  expect(ctx.mgr.findAdapter('grok')).toBeNull();
});

test('it reports no screen detector when no registered adapter provides one', async () => {
  await using ctx = await setupTest({
    adapter: buildMockAgentAdapter(),
    adapters: [buildMockAgentAdapter({ id: 'zai' })],
  });

  expect(ctx.mgr.hasScreenDetector).toBeFalse();
});

test('it reports a screen detector when a registered adapter provides one', async () => {
  await using ctx = await setupTest({
    adapter: buildMockAgentAdapter(),
    adapters: [
      buildMockAgentAdapter({ id: 'zai', screenDetector: { detectAttention: () => null } }),
    ],
  });

  expect(ctx.mgr.hasScreenDetector).toBeTrue();
});

test('it links a restored sub-session to the parent already registered under its session id', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [] });

  const parent = ctx.mgr.restore({
    sessionID: toSessionID('s-c-parent'),
    name: 'wrangler',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
  });

  const child = ctx.mgr.restore({
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
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [] });

  const child = ctx.mgr.restore({
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
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [] });

  const parent = ctx.mgr.restore({
    sessionID: toSessionID('s-c-parent'),
    name: 'wrangler',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
  });

  const child = await ctx.mgr.spawn(
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

  await ctx.mgr.writeFleet();

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

test('it refuses to pin a sub-session and leaves it unpinned', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [] });

  ctx.mgr.restore({
    sessionID: toSessionID('s-c-parent'),
    name: 'wrangler',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
  });

  const child = ctx.mgr.restore({
    sessionID: toSessionID('s-c-child'),
    name: 'worker',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-child'),
    agent: 'claude',
    parent: toSessionID('s-c-parent'),
  });

  const pinned = ctx.mgr.updateSession(child.id, undefined, true);

  expect({ pinned, isPinned: child.pinned }).toStrictEqual({
    pinned: 'child_pin',
    isPinned: false,
  });
});

test('it pins a parent that has a sub-session', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [] });

  const parent = ctx.mgr.restore({
    sessionID: toSessionID('s-c-parent'),
    name: 'wrangler',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
  });

  ctx.mgr.restore({
    sessionID: toSessionID('s-c-child'),
    name: 'worker',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-child'),
    agent: 'claude',
    parent: toSessionID('s-c-parent'),
  });

  expect(ctx.mgr.updateSession(parent.id, undefined, true)).toBeTrue();
});

test('it kills a live sub-session along with its parent', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [] });

  const parent = await ctx.mgr.spawn(ctx.dir, 'wrangler', '', 80, 24, false, 'user', 'claude');

  const child = await ctx.mgr.spawn(
    ctx.dir,
    'worker',
    '',
    80,
    24,
    false,
    'user',
    'claude',
    parent.id,
  );

  await ctx.mgr.kill(parent.id);

  expect({ parent: parent.state, child: child.state, link: child.parent }).toStrictEqual({
    parent: 'exited',
    child: 'exited',
    link: parent.id,
  });
});

test('it forgets a dead parent with its dead sub-sessions and promotes the live ones', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [] });

  const parent = ctx.mgr.restore({
    sessionID: toSessionID('s-c-parent'),
    name: 'wrangler',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
    exited: true,
  });

  ctx.mgr.restore({
    sessionID: toSessionID('s-c-dead'),
    name: 'dead worker',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-dead'),
    agent: 'claude',
    exited: true,
    parent: toSessionID('s-c-parent'),
  });

  const live = await ctx.mgr.spawn(
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

  await ctx.mgr.kill(parent.id);

  expect(ctx.mgr.sessions.map((s) => ({ id: s.id, parent: s.parent }))).toStrictEqual([
    { id: live.id, parent: null },
  ]);
});

test('it keeps an exited sub-session on a host-destroying target when a second kill forgets its dead local parent', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [] });

  ctx.mgr.restore({
    sessionID: toSessionID('s-parent'),
    name: 'wrangler',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
    exited: true,
    target: 'local',
    targetIdentity: buildTargetIdentity('local-pty', {}),
  });

  const remote = ctx.mgr.restore({
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

  await ctx.mgr.kill(toSessionID('s-parent'));

  expect(ctx.mgr.sessions.map((s) => ({ id: s.id, parent: s.parent }))).toStrictEqual([
    { id: remote.id, parent: null },
  ]);
});

test("it refuses to forget a session kept asleep inside its parent's host and keeps its record", async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [] });

  ctx.mgr.restore({
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

  ctx.mgr.restore({
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

  const forgotten = ctx.mgr.forget(toSessionID('s-guest'));

  expect(forgotten).rejects.toMatchObject({
    code: 'unsupported_operation',
    data: { problem: 'host_asleep', host: 's-parent' },
  });

  expect(ctx.mgr.sessions.map((s) => s.id)).toStrictEqual([
    toSessionID('s-parent'),
    toSessionID('s-guest'),
  ]);
});

test("it forgets an exited session on its parent's host while that host is not asleep", async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [] });

  ctx.mgr.restore({
    sessionID: toSessionID('s-parent'),
    name: 'wrangler',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
    exited: true,
    target: 'box',
    targetIdentity: 'imp-like:test',
  });

  ctx.mgr.restore({
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

  const destroyed = await ctx.mgr.forget(toSessionID('s-guest'));

  expect({ destroyed, ids: ctx.mgr.sessions.map((s) => s.id) }).toStrictEqual({
    destroyed: false,
    ids: [toSessionID('s-parent')],
  });
});

test("it keeps a finished turn's last message as the session result", async () => {
  await using ctx = await setupTest({
    adapter: buildMockAgentAdapter(),
    adapters: [
      buildMockAgentAdapter({
        normalizeHook: () => ({ kind: 'turn-done', result: 'all green' }),
      }),
    ],
  });

  const s = await ctx.mgr.spawn(ctx.dir, 'worker', 'go', 80, 24, toAgentSessionID('c-1'));

  ctx.mgr.applyHook({ atcId: s.id, event: 'Stop', payload: {} });

  await ctx.mgr.writeFleet();

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
  await using ctx = await setupTest({
    adapter: buildMockAgentAdapter(),
    adapters: [
      buildMockAgentAdapter({
        normalizeHook: () => ({ kind: 'turn-done', result: 'x'.repeat(20_000) }),
      }),
    ],
  });

  const s = await ctx.mgr.spawn(ctx.dir, 'worker', 'go', 80, 24, toAgentSessionID('c-1'));

  ctx.mgr.applyHook({ atcId: s.id, event: 'Stop', payload: {} });

  await ctx.mgr.writeFleet();

  const [stored] = await ctx.store.loadFleet();

  expect(stored?.result).toBe(`${'x'.repeat(16_381)}…`);
});

test('it persists the transcript path its hooks report', async () => {
  await using ctx = await setupTest({
    adapter: buildMockAgentAdapter(),
    adapters: [
      buildMockAgentAdapter({
        normalizeHook: () => ({
          kind: 'started',
          agentSessionID: toAgentSessionID('c-2'),
          transcriptSource: '/t/c-2.jsonl',
        }),
      }),
    ],
  });

  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  ctx.mgr.applyHook({ atcId: s.id, event: 'SessionStart', payload: {} });

  await ctx.mgr.writeFleet();

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
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [] });

  const session = ctx.mgr.restore({
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
  await using ctx = await setupTest({
    adapter: buildMockAgentAdapter(),
    adapters: [
      buildMockAgentAdapter({
        normalizeHook: () => ({ kind: 'turn-done', result: 'all green' }),
      }),
    ],
  });

  const finisher = await ctx.mgr.spawn(ctx.dir, 'finisher', 'go', 80, 24, toAgentSessionID('c-1'));
  const crasher = await ctx.mgr.spawn(ctx.dir, 'crasher', 'go', 80, 24, toAgentSessionID('c-2'));

  await ctx.mgr.writeFleet();

  crasher.pty?.kill();

  await waitFor(() => {
    expect(crasher.state).toBe('exited');
  });

  ctx.mgr.applyHook({ atcId: finisher.id, event: 'Stop', payload: {} });

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
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [] });

  const session = ctx.mgr.restore({
    sessionID: toSessionID('7d3f0c1e-2b4a-4c5d-8e9f-0a1b2c3d4e5f'),
    name: 'claude work',
    cwd: '/work/proj',
    agentSessionID: toAgentSessionID('c-1'),
    agent: 'claude',
  });

  expect(session.id).toBe(toSessionID('7d3f0c1e-2b4a-4c5d-8e9f-0a1b2c3d4e5f'));
});

test('it restores an entry with no agent session id as exited', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [] });

  const session = ctx.mgr.restore({
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
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [] });

  const s = await ctx.mgr.spawn(ctx.dir, 'booting', '', 80, 24);

  await ctx.mgr.writeFleet();

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
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [] });

  const session = ctx.mgr.restore({
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

  ctx.mgr.updateSession(session.id, 'renamed');

  await waitFor(() => {
    expect(ctx.lines).toStrictEqual([
      'atc fleet write for session s-1 failed (internal): no such table: fleet',
    ]);
  });

  expect(session.name).toBe('renamed');
});

test('it logs a background row update that fails', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [] });

  const session = ctx.mgr.restore({
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

  ctx.mgr.updateSurfaceState(session.id, 'done', 'finished', 'the result');

  await waitFor(() => {
    expect(ctx.lines).toStrictEqual([
      'atc fleet write for session s-1 failed (internal): no such table: fleet',
    ]);
  });
});

test('it logs nothing for a background fleet write refused as stale_epoch', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter(), adapters: [] });

  const session = ctx.mgr.restore({
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

  ctx.mgr.updateSession(session.id, 'renamed');

  // The store serves one write at a time, so this refusal settles only after
  // the background write's refusal has been handled.
  expect(ctx.mgr.writeFleet()).rejects.toMatchObject({ code: 'stale_epoch' });
  expect(ctx.lines).toStrictEqual([]);
});
