import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '../../test/wait-for';
import type { AgentAdapter } from '../agents/agent-adapter';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildTargetIdentity } from './build-target-identity';
import { LocalPTYProvider } from './local-pty-provider';
import { SessionManager } from './sessions';

// Registry-level tests: which agent id resolves to which adapter, and what a
// restored session does when its id resolves to none.
const idleAdapter: AgentAdapter = {
  id: 'claude',
  headlessRunner: null,
  screenDetector: null,
  takesMessages: false,
  planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
  normalizeHook: () => ({ kind: 'heartbeat' }),
  loadName: () => Promise.resolve(null),
  canResume: () => true,
  buildResumeCommand: () => null,
};

async function setupManager(adapters: readonly AgentAdapter[] = []): Promise<SessionManager> {
  const dir = mkdtempSync(join(tmpdir(), 'atc-sessions-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const store = await StateStore.open(join(dir, 'state.db'));

  return new SessionManager(idleAdapter, store, join(dir, 'status.json'), adapters);
}

test('it restores an entry whose agent id is registered as waiting for its terminal', async () => {
  const mgr = await setupManager();

  const session = mgr.restore({
    sessionID: toSessionID('s-c-1'),
    name: 'claude work',
    cwd: '/tmp/proj',

    agentSessionID: toAgentSessionID('c-1'),
    agent: 'claude',
  });

  expect(session.lastMsg).toBe('waiting to restore');
});

test('it restores an entry whose agent id is unregistered without reviving it as another agent', async () => {
  const mgr = await setupManager();

  const session = mgr.restore({
    sessionID: toSessionID('s-z-1'),
    name: 'glm work',
    cwd: '/tmp/proj',

    agentSessionID: toAgentSessionID('z-1'),
    agent: 'zai',
  });

  expect(session.lastMsg).toBe("no adapter for 'zai'");

  const adopted = await mgr.adoptTerminal(session.id, 80, 24);

  expect(adopted).toBeNull();
});

test('it resolves an agent id to the adapter that declares it, not to the default', async () => {
  const gateway: AgentAdapter = { ...idleAdapter, id: 'zai' };

  const mgr = await setupManager([gateway]);

  expect(mgr.findAdapter('zai')).toBe(gateway);
  expect(mgr.findAdapter('claude')).toBe(idleAdapter);
  expect(mgr.findAdapter('grok')).toBeNull();
});

test('it reports no screen detector when no registered adapter provides one', async () => {
  const other: AgentAdapter = { ...idleAdapter, id: 'zai' };

  const mgr = await setupManager([other]);

  expect(mgr.hasScreenDetector).toBe(false);
});

test('it reports a screen detector when a registered adapter provides one', async () => {
  const withDetector: AgentAdapter = {
    ...idleAdapter,
    id: 'zai',
    screenDetector: { detectAttention: () => null },
  };

  const mgr = await setupManager([withDetector]);

  expect(mgr.hasScreenDetector).toBe(true);
});

test('it links a restored sub-session to the parent already registered under its session id', async () => {
  const mgr = await setupManager();

  const parent = mgr.restore({
    sessionID: toSessionID('s-c-parent'),
    name: 'wrangler',
    cwd: '/tmp/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
  });

  const child = mgr.restore({
    sessionID: toSessionID('s-c-child'),
    name: 'worker',
    cwd: '/tmp/proj',
    agentSessionID: toAgentSessionID('c-child'),
    agent: 'claude',
    parent: toSessionID('s-c-parent'),
  });

  expect(child.parent).toBe(parent.id);
});

test('it restores a sub-session whose parent is absent as a top-level session', async () => {
  const mgr = await setupManager();

  const child = mgr.restore({
    sessionID: toSessionID('s-c-child'),
    name: 'worker',
    cwd: '/tmp/proj',
    agentSessionID: toAgentSessionID('c-child'),
    agent: 'claude',
    parent: toSessionID('s-c-gone'),
  });

  expect(child.parent).toBeNull();
});

test('it persists a sub-session link by the parent atc session id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-sessions-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const store = await StateStore.open(join(dir, 'state.db'));

  const mgr = new SessionManager(idleAdapter, store, join(dir, 'status.json'), []);

  const parent = mgr.restore({
    sessionID: toSessionID('s-c-parent'),
    name: 'wrangler',
    cwd: '/tmp/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
  });

  const child = await mgr.spawn(
    '/tmp',
    'worker',
    '',
    80,
    24,
    toAgentSessionID('c-child'),
    'user',
    'claude',
    parent.id,
  );

  onTestFinished(() => {
    mgr.detachAll();
  });

  await mgr.writeFleet();

  const stored = await store.loadFleet();

  expect(stored).toStrictEqual([
    {
      sessionID: toSessionID('s-c-parent'),
      name: 'wrangler',
      cwd: '/tmp/proj',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
      target: 'local',
      targetIdentity: buildTargetIdentity('local-pty', {}),
      lastAttachedAt: expect.toBeNumber(),
    },
    {
      sessionID: child.id,
      name: 'worker',
      cwd: '/tmp',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      target: 'local',
      targetIdentity: buildTargetIdentity('local-pty', {}),
      lastAttachedAt: expect.toBeNumber(),
      parent: parent.id,
    },
  ]);
});

test('it refuses to pin a sub-session', async () => {
  const mgr = await setupManager();

  const parent = mgr.restore({
    sessionID: toSessionID('s-c-parent'),
    name: 'wrangler',
    cwd: '/tmp/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
  });

  const child = mgr.restore({
    sessionID: toSessionID('s-c-child'),
    name: 'worker',
    cwd: '/tmp/proj',
    agentSessionID: toAgentSessionID('c-child'),
    agent: 'claude',
    parent: toSessionID('s-c-parent'),
  });

  expect(mgr.updateSession(child.id, undefined, true)).toBe('child_pin');
  expect(mgr.updateSession(parent.id, undefined, true)).toBe(true);
  expect(child.pinned).toBe(false);
});

test('it kills a live sub-session along with its parent', async () => {
  const mgr = await setupManager();
  const parent = await mgr.spawn('/tmp', 'wrangler', '', 80, 24, false, 'user', 'claude');
  const child = await mgr.spawn('/tmp', 'worker', '', 80, 24, false, 'user', 'claude', parent.id);

  onTestFinished(() => {
    mgr.detachAll();
  });

  await mgr.kill(parent.id);

  expect(parent.state).toBe('exited');
  expect(child.state).toBe('exited');
  expect(child.parent).toBe(parent.id);
});

test('it forgets a dead parent with its dead sub-sessions and promotes the live ones', async () => {
  const mgr = await setupManager();

  const parent = mgr.restore({
    sessionID: toSessionID('s-c-parent'),
    name: 'wrangler',
    cwd: '/tmp/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
    exited: true,
  });

  const dead = mgr.restore({
    sessionID: toSessionID('s-c-dead'),
    name: 'dead worker',
    cwd: '/tmp/proj',
    agentSessionID: toAgentSessionID('c-dead'),
    agent: 'claude',
    exited: true,
    parent: toSessionID('s-c-parent'),
  });

  const live = await mgr.spawn(
    '/tmp',
    'live worker',
    '',
    80,
    24,
    false,
    'user',
    'claude',
    parent.id,
  );

  onTestFinished(() => {
    mgr.detachAll();
  });

  await mgr.kill(parent.id);

  expect(mgr.sessions.map((s) => s.id)).toStrictEqual([live.id]);
  expect(mgr.sessions.some((s) => s.id === dead.id)).toBe(false);
  expect(live.parent).toBeNull();
});

test('it keeps an exited sub-session on a host-destroying target when a second kill forgets its dead local parent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-sessions-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const local = new LocalPTYProvider();

  const store = await StateStore.open(join(dir, 'state.db'));

  const mgr = new SessionManager(
    idleAdapter,
    store,
    join(dir, 'status.json'),
    [],
    [
      { id: 'local', kind: 'local-pty', options: {}, identity: 'local-pty:test', provider: local },
      {
        id: 'box',
        kind: 'imp-like',
        options: {},
        identity: 'imp-like:test',
        provider: {
          kind: 'imp-like',
          remote: false,
          capabilities: { ...local.capabilities, suspend: true, destroy: true },
          prepareHost: () => Promise.resolve(),
          spawnHarness: local.spawnHarness,
          transferArchive: local.transferArchive,
          runCommand: local.runCommand,
          suspendHost: () => Promise.resolve(),
          destroyHost: () => Promise.resolve(),
          dispose: () => {},
        },
      },
    ],
  );

  mgr.restore({
    sessionID: toSessionID('s-parent'),
    name: 'wrangler',
    cwd: '/tmp/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
    exited: true,
    target: 'local',
    targetIdentity: 'local-pty:test',
  });

  const remote = mgr.restore({
    sessionID: toSessionID('s-remote'),
    name: 'remote worker',
    cwd: '/tmp/proj',
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
  const dir = mkdtempSync(join(tmpdir(), 'atc-sessions-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const local = new LocalPTYProvider();

  const store = await StateStore.open(join(dir, 'state.db'));

  const mgr = new SessionManager(
    idleAdapter,
    store,
    join(dir, 'status.json'),
    [],
    [
      {
        id: 'box',
        kind: 'imp-like',
        options: {},
        identity: 'imp-like:test',
        provider: {
          kind: 'imp-like',
          remote: false,
          capabilities: { ...local.capabilities, suspend: true, destroy: true },
          prepareHost: () => Promise.resolve(),
          spawnHarness: local.spawnHarness,
          transferArchive: local.transferArchive,
          runCommand: local.runCommand,
          suspendHost: () => Promise.resolve(),
          destroyHost: () => Promise.resolve(),
          dispose: () => {},
        },
      },
    ],
  );

  mgr.restore({
    sessionID: toSessionID('s-parent'),
    name: 'wrangler',
    cwd: '/tmp/proj',
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
    cwd: '/tmp/proj',
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

  await forgotten.catch(() => null);

  expect(mgr.sessions.map((s) => s.id)).toStrictEqual([
    toSessionID('s-parent'),
    toSessionID('s-guest'),
  ]);
});

test("it forgets an exited session on its parent's host while that host is not asleep", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-sessions-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const local = new LocalPTYProvider();

  const store = await StateStore.open(join(dir, 'state.db'));

  const mgr = new SessionManager(
    idleAdapter,
    store,
    join(dir, 'status.json'),
    [],
    [
      {
        id: 'box',
        kind: 'imp-like',
        options: {},
        identity: 'imp-like:test',
        provider: {
          kind: 'imp-like',
          remote: false,
          capabilities: { ...local.capabilities, suspend: true, destroy: true },
          prepareHost: () => Promise.resolve(),
          spawnHarness: local.spawnHarness,
          transferArchive: local.transferArchive,
          runCommand: local.runCommand,
          suspendHost: () => Promise.resolve(),
          destroyHost: () => Promise.resolve(),
          dispose: () => {},
        },
      },
    ],
  );

  mgr.restore({
    sessionID: toSessionID('s-parent'),
    name: 'wrangler',
    cwd: '/tmp/proj',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
    exited: true,
    target: 'box',
    targetIdentity: 'imp-like:test',
  });

  mgr.restore({
    sessionID: toSessionID('s-guest'),
    name: 'guest',
    cwd: '/tmp/proj',
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
  const dir = mkdtempSync(join(tmpdir(), 'atc-sessions-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const store = await StateStore.open(join(dir, 'state.db'));

  const finishing: AgentAdapter = {
    ...idleAdapter,
    normalizeHook: () => ({ kind: 'turn-done', result: 'all green' }),
  };

  const mgr = new SessionManager(idleAdapter, store, join(dir, 'status.json'), [finishing]);

  const s = await mgr.spawn('/tmp', 'worker', 'go', 80, 24, toAgentSessionID('c-1'));

  onTestFinished(() => {
    mgr.detachAll();
  });

  mgr.applyHook({ atcId: s.id, event: 'Stop', payload: {} });

  await mgr.writeFleet();

  const stored = await store.loadFleet();

  expect(stored).toStrictEqual([
    {
      sessionID: s.id,
      name: 'worker',
      cwd: '/tmp',
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
  const dir = mkdtempSync(join(tmpdir(), 'atc-sessions-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const store = await StateStore.open(join(dir, 'state.db'));

  const finishing: AgentAdapter = {
    ...idleAdapter,
    normalizeHook: () => ({ kind: 'turn-done', result: 'x'.repeat(20_000) }),
  };

  const mgr = new SessionManager(idleAdapter, store, join(dir, 'status.json'), [finishing]);

  const s = await mgr.spawn('/tmp', 'worker', 'go', 80, 24, toAgentSessionID('c-1'));

  onTestFinished(() => {
    mgr.detachAll();
  });

  mgr.applyHook({ atcId: s.id, event: 'Stop', payload: {} });

  await mgr.writeFleet();

  const [stored] = await store.loadFleet();

  if (stored?.result === undefined) {
    throw new Error('expected a stored result');
  }

  expect(Buffer.byteLength(stored.result)).toBeLessThanOrEqual(16_384);
});

test('it persists the transcript path its hooks report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-sessions-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const store = await StateStore.open(join(dir, 'state.db'));

  const starting: AgentAdapter = {
    ...idleAdapter,
    normalizeHook: () => ({
      kind: 'started',
      agentSessionID: toAgentSessionID('c-2'),
      transcriptSource: '/t/c-2.jsonl',
    }),
  };

  const mgr = new SessionManager(idleAdapter, store, join(dir, 'status.json'), [starting]);

  const s = await mgr.spawn('/tmp', 'worker', '', 80, 24);

  onTestFinished(() => {
    mgr.detachAll();
  });

  mgr.applyHook({ atcId: s.id, event: 'SessionStart', payload: {} });

  await mgr.writeFleet();

  const stored = await store.loadFleet();

  expect(stored).toStrictEqual([
    {
      sessionID: s.id,
      name: 'worker',
      cwd: '/tmp',
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
  const mgr = await setupManager();

  const session = mgr.restore({
    sessionID: toSessionID('s-c-1'),
    name: 'wrangler',
    cwd: '/tmp/proj',
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
  const dir = mkdtempSync(join(tmpdir(), 'atc-sessions-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const store = await StateStore.open(join(dir, 'state.db'));

  const finishing: AgentAdapter = {
    ...idleAdapter,
    normalizeHook: () => ({ kind: 'turn-done', result: 'all green' }),
  };

  const mgr = new SessionManager(idleAdapter, store, join(dir, 'status.json'), [finishing]);

  const finisher = await mgr.spawn('/tmp', 'finisher', 'go', 80, 24, toAgentSessionID('c-1'));
  const crasher = await mgr.spawn('/tmp', 'crasher', 'go', 80, 24, toAgentSessionID('c-2'));

  onTestFinished(() => {
    mgr.detachAll();
  });

  await mgr.writeFleet();

  crasher.pty?.kill();
  const deadline = Date.now() + 5000;

  while (crasher.state !== 'exited' && Date.now() < deadline) {
    await Bun.sleep(10);
  }

  mgr.applyHook({ atcId: finisher.id, event: 'Stop', payload: {} });

  let stored = await store.loadFleet();

  while (!stored.some((e) => e.result === 'all green') && Date.now() < deadline) {
    await Bun.sleep(10);

    stored = await store.loadFleet();
  }

  expect(crasher.state).toBe('exited');

  expect(stored).toStrictEqual([
    {
      sessionID: finisher.id,
      name: 'finisher',
      cwd: '/tmp',
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
      cwd: '/tmp',
      agentSessionID: toAgentSessionID('c-2'),
      agent: 'claude',
      target: 'local',
      targetIdentity: buildTargetIdentity('local-pty', {}),
      lastAttachedAt: expect.toBeNumber(),
      prompt: 'go',
    },
  ]);
});

test('it restores an entry under the session id its row holds', async () => {
  const mgr = await setupManager();

  const session = mgr.restore({
    sessionID: toSessionID('7d3f0c1e-2b4a-4c5d-8e9f-0a1b2c3d4e5f'),
    name: 'claude work',
    cwd: '/tmp/proj',
    agentSessionID: toAgentSessionID('c-1'),
    agent: 'claude',
  });

  expect(session.id).toBe(toSessionID('7d3f0c1e-2b4a-4c5d-8e9f-0a1b2c3d4e5f'));
});

test('it restores an entry with no agent session id as exited', async () => {
  const mgr = await setupManager();

  const session = mgr.restore({
    sessionID: toSessionID('s-booting'),
    name: 'booting',
    cwd: '/tmp/proj',
    agent: 'claude',
  });

  expect(session.state).toBe('exited');
  expect(session.lastMsg).toBe('nothing to resume');
});

test('it persists a session the agent has not yet given a session id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-sessions-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const store = await StateStore.open(join(dir, 'state.db'));

  const mgr = new SessionManager(idleAdapter, store, join(dir, 'status.json'), []);

  const s = await mgr.spawn('/tmp', 'booting', '', 80, 24);

  onTestFinished(() => {
    mgr.detachAll();
  });

  await mgr.writeFleet();

  const stored = await store.loadFleet();

  expect(stored).toStrictEqual([
    {
      sessionID: s.id,
      name: 'booting',
      cwd: '/tmp',
      agent: 'claude',
      target: 'local',
      targetIdentity: buildTargetIdentity('local-pty', {}),
      lastAttachedAt: expect.toBeNumber(),
    },
  ]);
});

test('it logs a background fleet write that fails and keeps the change in memory', async () => {
  const lines: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'atc-sessions-'));

  const store = await StateStore.open(join(dir, 'state.db'));

  onTestFinished(async () => {
    await store.stop();

    rmSync(dir, { recursive: true, force: true });
  });

  const mgr = new SessionManager(idleAdapter, store, join(dir, 'status.json'));

  mgr.log = (line) => {
    lines.push(line);
  };

  const session = mgr.restore({
    sessionID: toSessionID('s-1'),
    name: 'work',
    cwd: '/tmp/proj',
    agent: 'claude',
  });

  // Another connection drops the table, so the store's write fails in SQLite.
  const db = new Database(join(dir, 'state.db'));

  db.run('DROP TABLE fleet');
  db.close();
  mgr.updateSession(session.id, 'renamed');

  await waitFor(() => {
    expect(lines).toStrictEqual([
      'atc fleet write for session s-1 failed (internal): no such table: fleet',
    ]);
  });

  expect(session.name).toBe('renamed');
});

test('it logs a background row update that fails', async () => {
  const lines: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'atc-sessions-'));

  const store = await StateStore.open(join(dir, 'state.db'));

  onTestFinished(async () => {
    await store.stop();

    rmSync(dir, { recursive: true, force: true });
  });

  const mgr = new SessionManager(idleAdapter, store, join(dir, 'status.json'));

  mgr.log = (line) => {
    lines.push(line);
  };

  const session = mgr.restore({
    sessionID: toSessionID('s-1'),
    name: 'work',
    cwd: '/tmp/proj',
    agent: 'claude',
  });

  const db = new Database(join(dir, 'state.db'));

  db.run('DROP TABLE fleet');
  db.close();
  mgr.updateSurfaceState(session.id, 'done', 'finished', 'the result');

  await waitFor(() => {
    expect(lines).toStrictEqual([
      'atc fleet write for session s-1 failed (internal): no such table: fleet',
    ]);
  });
});

test('it logs nothing for a background fleet write refused as stale_epoch', async () => {
  const lines: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'atc-sessions-'));

  const store = await StateStore.open(join(dir, 'state.db'));

  onTestFinished(async () => {
    await store.stop();

    rmSync(dir, { recursive: true, force: true });
  });

  const mgr = new SessionManager(idleAdapter, store, join(dir, 'status.json'));

  mgr.log = (line) => {
    lines.push(line);
  };

  const session = mgr.restore({
    sessionID: toSessionID('s-1'),
    name: 'work',
    cwd: '/tmp/proj',
    agent: 'claude',
  });

  // An owner row from a later ownership epoch, which this daemon's writes
  // may no longer replace.
  const db = new Database(join(dir, 'state.db'));

  db.run(
    'INSERT INTO session_owner (session_id, daemon_id, owner_epoch, updated_at) VALUES (?, ?, 2, 0)',
    ['s-1', store.daemonID],
  );

  db.close();
  mgr.updateSession(session.id, 'renamed');

  // The store serves one write at a time, so this refusal settles after the
  // background write's.
  expect(mgr.writeFleet()).rejects.toMatchObject({ code: 'stale_epoch' });

  await mgr.writeFleet().catch(() => null);
  await Bun.sleep(0);

  expect(lines).toStrictEqual([]);
});
