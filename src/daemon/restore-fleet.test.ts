import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { waitFor } from '../test-utils/wait-for';
import { restoreFleet } from './restore-fleet';
import type { SessionRuntime } from './session-runtime';
import { SessionManager } from './sessions';
import type { Session } from './sessions';

/**
 * A session manager over a fresh state store, as one daemon life sees it.
 */
async function setupTest() {
  const tmp = setupTempDir('atc-restore-');

  const store = await StateStore.open(join(tmp.dir, 'state.db'));

  registerTestCleanup(() => store.stop());

  const statusPath = join(tmp.dir, 'status.json');

  const mgr = new SessionManager(buildMockAgentAdapter(), store, statusPath, []);

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  const runtimes = new Map<string, SessionRuntime>();

  return {
    dir: tmp.dir,
    statusPath,
    store,
    mgr,
    findRuntime: (id: string) => runtimes.get(id),
  };
}

test('it lists every restored session under the session id its row holds', async () => {
  const ctx = await setupTest();

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-kept'),
      cwd: ctx.dir,
      agentSessionID: toAgentSessionID('c-kept'),
    }),
  ]);

  const restored = await restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  expect(restored.restored).toBe(1);
  expect(ctx.mgr.sessions.map((s) => s.id)).toStrictEqual([toSessionID('s-kept')]);
});

test('it revives a listed dead session in place instead of listing its id twice', async () => {
  const ctx = await setupTest();
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24, toAgentSessionID('c-1'));

  await ctx.mgr.writeFleet();

  s.pty?.kill();

  await waitFor(() => {
    expect(s.state).toBe('exited');
  });

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
  const ctx = await setupTest();

  // The next daemon life, over the same store. Before the store closes, its
  // release waits for every session it holds to get its terminal and writes
  // its fleet once more: each adopted terminal fires a fleet write, and the
  // last write queues behind them, so none lands after the store closes.
  const restarted = new SessionManager(buildMockAgentAdapter(), ctx.store, ctx.statusPath, []);

  registerTestCleanup(() => {
    restarted.detachAll();
  });

  registerTestCleanup(async () => {
    await waitFor(() => {
      expect(restarted.sessions).toSatisfyAll((s: Session) => s.pty !== null);
    });

    await restarted.writeFleet();
  });

  const parent = ctx.mgr.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-parent'),
      name: 'wrangler',
      cwd: ctx.dir,
      agentSessionID: toAgentSessionID('c-parent'),
      exited: true,
    }),
  );

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

  const resumed = await ctx.mgr.spawn(
    ctx.dir,
    'wrangler',
    '',
    80,
    24,
    toAgentSessionID('c-parent'),
  );

  await ctx.mgr.writeFleet();

  await restoreFleet({
    mgr: restarted,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  const restoredChild = restarted.sessions.find((s) => s.id === child.id);

  expect(restoredChild?.parent).toBe(resumed.id);
});

test('it keeps a sub-session under a sub-session that resumed their parent agent session', async () => {
  const ctx = await setupTest();

  // The next daemon life, over the same store. Before the store closes, its
  // release waits for every session it holds to get its terminal and writes
  // its fleet once more: each adopted terminal fires a fleet write, and the
  // last write queues behind them, so none lands after the store closes.
  const restarted = new SessionManager(buildMockAgentAdapter(), ctx.store, ctx.statusPath, []);

  registerTestCleanup(() => {
    restarted.detachAll();
  });

  registerTestCleanup(async () => {
    await waitFor(() => {
      expect(restarted.sessions).toSatisfyAll((s: Session) => s.pty !== null);
    });

    await restarted.writeFleet();
  });

  const parent = ctx.mgr.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-parent'),
      name: 'wrangler',
      cwd: ctx.dir,
      agentSessionID: toAgentSessionID('c-parent'),
      exited: true,
    }),
  );

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

  // Spawned under the session whose agent session it resumes, so the
  // row it replaces is its own parent.
  const resumed = await ctx.mgr.spawn(
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

  await ctx.mgr.writeFleet();

  await restoreFleet({
    mgr: restarted,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  const restored = restarted.sessions.map((s) => [s.id, s.parent]);

  expect(restored).toIncludeSameMembers([
    [child.id, resumed.id],
    [resumed.id, null],
  ]);
});

test('it restores two crossed resumes with the earlier one top-level and the later one under it', async () => {
  const ctx = await setupTest();

  // The next daemon life, over the same store. Before the store closes, its
  // release waits for every session it holds to get its terminal and writes
  // its fleet once more: each adopted terminal fires a fleet write, and the
  // last write queues behind them, so none lands after the store closes.
  const restarted = new SessionManager(buildMockAgentAdapter(), ctx.store, ctx.statusPath, []);

  registerTestCleanup(() => {
    restarted.detachAll();
  });

  registerTestCleanup(async () => {
    await waitFor(() => {
      expect(restarted.sessions).toSatisfyAll((s: Session) => s.pty !== null);
    });

    await restarted.writeFleet();
  });

  const first = ctx.mgr.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-p'),
      name: 'p',
      cwd: ctx.dir,
      agentSessionID: toAgentSessionID('c-a'),
      exited: true,
    }),
  );

  const second = ctx.mgr.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-q'),
      name: 'q',
      cwd: ctx.dir,
      agentSessionID: toAgentSessionID('c-b'),
      exited: true,
    }),
  );

  const resumedFirst = await ctx.mgr.spawn(
    ctx.dir,
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
    ctx.dir,
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

  await restoreFleet({
    mgr: restarted,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  const restored = restarted.sessions.map((s) => [s.id, s.parent]);

  expect(restored).toIncludeSameMembers([
    [resumedFirst.id, null],
    [resumedSecond.id, resumedFirst.id],
  ]);
});
