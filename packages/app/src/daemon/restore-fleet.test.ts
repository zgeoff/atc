import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { toAgentSessionID } from '@atc/core/to-agent-session-id';
import { toSessionID } from '@atc/core/to-session-id';
import type { AgentAdapter } from '@atc/plugin-api/agent-adapter';
import { StateStore } from '@atc/store/state-store';
import { buildMockFleetEntry } from '@atc/store/testing/build-mock-fleet-entry';
import { buildMockAgentAdapter } from '@atc/test-utils/build-mock-agent-adapter';
import { buildStubHeadlessRunner } from '@atc/test-utils/build-stub-headless-runner';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { waitFor } from '@atc/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { restoreFleet } from './restore-fleet';
import { SessionRuntime } from './session-runtime';
import { SessionManager } from './sessions';
import type { Session } from './sessions';
import { startHeadlessTurn } from './start-headless-turn';

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

  const exitedPTY = s.pty;

  await restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  expect(ctx.mgr.sessions.map((x) => x.id)).toStrictEqual([s.id]);
  expect(exitedPTY).toBeNull();
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

test('it starts no terminal on a later restore for a session an earlier restore left without one that now runs a headless turn', async () => {
  const ctx = await setupTest();

  const planSpawn = mock<AgentAdapter['planSpawn']>(() => ({
    bin: 'sleep',
    args: ['30'],
  })).mockImplementationOnce(() => {
    throw new Error('the agent CLI is missing');
  });

  const headless = buildStubHeadlessRunner();

  const mgr = new SessionManager(
    buildMockAgentAdapter({ planSpawn, headlessRunner: headless.runner }),
    ctx.store,
    ctx.statusPath,
    [],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-headless'),
      cwd: ctx.dir,
      agentSessionID: toAgentSessionID('c-headless'),
    }),
  ]);

  const first = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
    retryDelaysMs: [],
  });

  await first.settled;

  const runtime = new SessionRuntime();

  const started = startHeadlessTurn(
    mgr,
    () => runtime,
    toSessionID('s-headless'),
    'keep going',
    () => {},
    join(ctx.dir, 'reporter.sock'),
  );

  invariant(started, 'the headless turn did not start');

  const restored = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
    retryDelaysMs: [],
  });

  await restored.settled;

  expect(planSpawn).toHaveBeenCalledOnce();
  expect(mgr.sessions).toMatchObject([{ id: 's-headless', kind: 'headless', pty: null }]);
  expect(headless.runs.map((run) => run.stopped)).toStrictEqual([false]);
});

test('it revives on a later restore a session an earlier restore left without a terminal whose headless runner threw', async () => {
  const ctx = await setupTest();

  const planSpawn = mock<AgentAdapter['planSpawn']>(() => ({
    bin: 'sleep',
    args: ['30'],
  })).mockImplementationOnce(() => {
    throw new Error('the agent CLI is missing');
  });

  const mgr = new SessionManager(
    buildMockAgentAdapter({
      planSpawn,
      headlessRunner: () => {
        throw new Error('the settings file cannot be written');
      },
    }),
    ctx.store,
    ctx.statusPath,
    [],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-headless'),
      cwd: ctx.dir,
      agentSessionID: toAgentSessionID('c-headless'),
    }),
  ]);

  const first = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
    retryDelaysMs: [],
  });

  await first.settled;

  const runtime = new SessionRuntime();

  expect(() =>
    startHeadlessTurn(
      mgr,
      () => runtime,
      toSessionID('s-headless'),
      'keep going',
      () => {},
      join(ctx.dir, 'reporter.sock'),
    ),
  ).toThrowWithMessage(Error, 'the settings file cannot be written');

  const restored = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
    retryDelaysMs: [],
  });

  await restored.settled;

  expect(mgr.sessions).toMatchObject([{ id: 's-headless', kind: 'pty', lastMsg: 'revived' }]);
});

test('it starts no terminal for a queued session whose headless turn starts while the restore waits on an earlier session', async () => {
  const ctx = await setupTest();

  const planSpawn = mock<AgentAdapter['planSpawn']>(() => ({
    bin: 'sleep',
    args: ['30'],
  }));

  const headless = buildStubHeadlessRunner();

  const mgr = new SessionManager(
    buildMockAgentAdapter({ planSpawn, headlessRunner: headless.runner }),
    ctx.store,
    ctx.statusPath,
    [],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-first'),
      cwd: ctx.dir,
      agentSessionID: toAgentSessionID('c-first'),
    }),
    buildMockFleetEntry({
      sessionID: toSessionID('s-second'),
      cwd: ctx.dir,
      agentSessionID: toAgentSessionID('c-second'),
    }),
  ]);

  // The first session never reports it has booted, so the restore waits on
  // it until the test releases the wait.
  const firstRuntime = new SessionRuntime();

  const restored = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: (id) => (id === toSessionID('s-first') ? firstRuntime : undefined),
    cols: 80,
    rows: 24,
    capMs: 0,
    retryDelaysMs: [],
  });

  await waitFor(() => {
    expect(firstRuntime.bootWaiter).not.toBeNull();
  });

  const started = startHeadlessTurn(
    mgr,
    () => new SessionRuntime(),
    toSessionID('s-second'),
    'keep going',
    () => {},
    join(ctx.dir, 'reporter.sock'),
  );

  invariant(started, 'the headless turn did not start');
  firstRuntime.bootWaiter?.();

  const outcome = await restored.settled;

  expect(outcome).toBe('finished');
  expect(planSpawn).toHaveBeenCalledOnce();

  expect(mgr.sessions).toMatchObject([
    { id: 's-first', kind: 'pty' },
    { id: 's-second', kind: 'headless', pty: null, lastMsg: 'headless turn running' },
  ]);

  expect(headless.runs.map((run) => run.stopped)).toStrictEqual([false]);
});
