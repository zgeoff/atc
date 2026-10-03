import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '../../test/wait-for';
import type { AgentAdapter } from '../agents/agent-adapter';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { restoreFleet } from './restore-fleet';
import type { SessionRuntime } from './session-runtime';
import { SessionManager } from './sessions';

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

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'atc-restore-'));
  const store = await StateStore.open(join(dir, 'state.db'));

  const statusPath = join(dir, 'status.json');

  const mgr = new SessionManager(idleAdapter, store, statusPath, []);
  const runtimes = new Map<string, SessionRuntime>();

  return {
    store,
    mgr,
    statusPath,
    findRuntime: (id: string) => runtimes.get(id),
    async [Symbol.asyncDispose]() {
      mgr.detachAll();

      await store.stop();

      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('it lists every restored session under the session id its row holds', async () => {
  await using ctx = await setupTest();

  await ctx.store.writeFleet([
    {
      sessionID: toSessionID('s-kept'),
      name: 'kept',
      cwd: '/tmp',
      agentSessionID: toAgentSessionID('c-kept'),
      agent: 'claude',
    },
  ]);

  const restored = await restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  expect(restored).toBe(1);
  expect(ctx.mgr.sessions.map((s) => s.id)).toStrictEqual([toSessionID('s-kept')]);
});

test('it revives a listed dead session in place instead of listing its id twice', async () => {
  await using ctx = await setupTest();

  const s = await ctx.mgr.spawn('/tmp', 'worker', '', 80, 24, toAgentSessionID('c-1'));

  await ctx.mgr.writeFleet();

  s.pty?.kill();
  const deadline = Date.now() + 5000;

  while (s.state !== 'exited' && Date.now() < deadline) {
    await Bun.sleep(10);
  }

  await restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  expect(ctx.mgr.sessions.map((x) => x.id)).toStrictEqual([s.id]);
  expect(s.pty).not.toBeNull();
});

test('it keeps a sub-session under the session that resumed its parent agent session', async () => {
  await using ctx = await setupTest();

  const parent = ctx.mgr.restore({
    sessionID: toSessionID('s-parent'),
    name: 'wrangler',
    cwd: '/tmp',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
    exited: true,
  });

  const child = await ctx.mgr.spawn(
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

  const resumed = await ctx.mgr.spawn('/tmp', 'wrangler', '', 80, 24, toAgentSessionID('c-parent'));

  await ctx.mgr.writeFleet();

  const restarted = new SessionManager(idleAdapter, ctx.store, ctx.statusPath, []);

  onTestFinished(() => {
    restarted.detachAll();
  });

  await restoreFleet({
    mgr: restarted,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  // Every adopted terminal fires a fleet write; the last write queues
  // behind them, so none lands after the store closes.
  await waitFor(() => {
    expect(restarted.sessions.every((s) => s.pty !== null)).toBe(true);
  });

  await restarted.writeFleet();

  const restoredChild = restarted.sessions.find((s) => s.id === child.id);

  expect(restoredChild?.parent).toBe(resumed.id);
});

test('it keeps a sub-session under a sub-session that resumed their parent agent session', async () => {
  await using ctx = await setupTest();

  const parent = ctx.mgr.restore({
    sessionID: toSessionID('s-parent'),
    name: 'wrangler',
    cwd: '/tmp',
    agentSessionID: toAgentSessionID('c-parent'),
    agent: 'claude',
    exited: true,
  });

  const child = await ctx.mgr.spawn(
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

  // Spawned under the session whose agent session it resumes, so the row
  // it replaces is its own parent.
  const resumed = await ctx.mgr.spawn(
    '/tmp',
    'wrangler',
    '',
    80,
    24,
    toAgentSessionID('c-parent'),
    'user',
    'claude',
    parent.id,
  );

  await ctx.mgr.writeFleet();

  const stored = await ctx.store.loadFleet();

  expect(stored.map((entry) => [entry.sessionID, entry.parent])).toStrictEqual([
    [child.id, resumed.id],
    [resumed.id, undefined],
  ]);

  const restarted = new SessionManager(idleAdapter, ctx.store, ctx.statusPath, []);

  onTestFinished(() => {
    restarted.detachAll();
  });

  await restoreFleet({
    mgr: restarted,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  await waitFor(() => {
    expect(restarted.sessions.every((s) => s.pty !== null)).toBe(true);
  });

  await restarted.writeFleet();

  const restored = restarted.sessions.map((s) => [s.id, s.parent]);

  expect(restored).toIncludeSameMembers([
    [child.id, resumed.id],
    [resumed.id, null],
  ]);
});

test('it restores two crossed resumes with the earlier one top-level and the later one under it', async () => {
  await using ctx = await setupTest();

  const first = ctx.mgr.restore({
    sessionID: toSessionID('s-p'),
    name: 'p',
    cwd: '/tmp',
    agentSessionID: toAgentSessionID('c-a'),
    agent: 'claude',
    exited: true,
  });

  const second = ctx.mgr.restore({
    sessionID: toSessionID('s-q'),
    name: 'q',
    cwd: '/tmp',
    agentSessionID: toAgentSessionID('c-b'),
    agent: 'claude',
    exited: true,
  });

  const resumedFirst = await ctx.mgr.spawn(
    '/tmp',
    'r',
    '',
    80,
    24,
    toAgentSessionID('c-a'),
    'user',
    'claude',
    second.id,
  );

  const resumedSecond = await ctx.mgr.spawn(
    '/tmp',
    's',
    '',
    80,
    24,
    toAgentSessionID('c-b'),
    'user',
    'claude',
    first.id,
  );

  await ctx.mgr.writeFleet();

  const restarted = new SessionManager(idleAdapter, ctx.store, ctx.statusPath, []);

  onTestFinished(() => {
    restarted.detachAll();
  });

  await restoreFleet({
    mgr: restarted,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  await waitFor(() => {
    expect(restarted.sessions.every((s) => s.pty !== null)).toBe(true);
  });

  await restarted.writeFleet();

  const restored = restarted.sessions.map((s) => [s.id, s.parent]);

  expect(restored).toIncludeSameMembers([
    [resumedFirst.id, null],
    [resumedSecond.id, resumedFirst.id],
  ]);
});
