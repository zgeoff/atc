import { expect, mock, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import type { SessionID } from '@atc/core';
import { toAgentSessionID, toSessionID } from '@atc/core';
import type { AgentAdapter } from '@atc/plugin-api';
import { StateStore, buildTargetIdentity } from '@atc/store';
import { buildMockFleetEntry, createMigratedStateDB } from '@atc/store/testing';
import {
  buildMockAgentAdapter,
  buildStubClock,
  buildStubHeadlessRunner,
  buildStubLog,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import type { Session } from '../sessions/session';
import { SessionRuntime } from '../sessions/session-runtime';
import { SessionManager } from '../sessions/sessions';
import { startHeadlessTurn } from '../sessions/start-headless-turn';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { buildStubRestoreImpProvider } from '../testing/build-stub-restore-imp-provider';
import { runLocalCommand } from '../testing/run-local-command';
import type { ExecutionTarget } from './build-execution-targets';
import { buildExecutionTargets } from './build-execution-targets';
import { restoreFleet } from './restore-fleet';

async function setupTest(config: Readonly<{ targets?: readonly ExecutionTarget[] }> = {}) {
  const tmp = setupTempDir('atc-restore-');
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const impProvider = buildStubRestoreImpProvider({ runCommand: runLocalCommand });

  const heldPrepares = new Map<string, PromiseWithResolvers<void>>();

  const held = buildStubMemoryProvider({
    kind: 'local-pty',
    prepareHost: (request) => {
      const wait = Promise.withResolvers<void>();

      heldPrepares.set(request.host, wait);

      return wait.promise;
    },
  });

  const recorder = buildStubLog();
  const statusPath = join(tmp.dir, 'status.json');

  // with no targets of the test's own, sessions run on the `local` target
  // under the identity a local row binds to
  const targets = config.targets ?? [
    {
      id: 'local',
      kind: 'local-pty',
      options: {},
      identity: buildTargetIdentity('local-pty', {}),
      provider: buildStubMemoryProvider({ kind: 'local-pty' }),
    },
  ];

  const mgr = new SessionManager(buildMockAgentAdapter(), store, statusPath, [], targets);

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  // no session holds a runtime, so a stagger waits on no boot
  const runtimes = new Map<SessionID, SessionRuntime>();

  return {
    dir: tmp.dir,
    statusPath,
    store,
    impProvider,
    held,
    release: (host: string) => {
      heldPrepares.get(host)?.resolve();
    },
    targets,
    mgr,
    logged: recorder.lines,
    log: recorder.log,
    findRuntime: (sessionID: SessionID) => runtimes.get(sessionID),
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

  // the next daemon life, over the same store
  const restarted = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    ctx.targets,
  );

  registerTestCleanup(() => {
    restarted.detachAll();
  });

  // each adopted terminal fires a fleet write and the last write queues behind them,
  // so waiting for every terminal before the store closes lets none land after it
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

  // the next daemon life, over the same store
  const restarted = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    ctx.targets,
  );

  registerTestCleanup(() => {
    restarted.detachAll();
  });

  // each adopted terminal fires a fleet write and the last write queues behind them,
  // so waiting for every terminal before the store closes lets none land after it
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

  // the next daemon life, over the same store
  const restarted = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    ctx.targets,
  );

  registerTestCleanup(() => {
    restarted.detachAll();
  });

  // each adopted terminal fires a fleet write and the last write queues behind them,
  // so waiting for every terminal before the store closes lets none land after it
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
    ctx.targets,
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
    ctx.targets,
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
    ctx.targets,
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

test('it restores sessions stored before the providers moved into packages by target id and target config revision', async () => {
  const built = buildExecutionTargets(
    [
      { id: 'local', provider: 'local-pty', options: {} },
      {
        id: 'cloud',
        provider: 'imp',
        options: {
          url: 'http://impd.example:7070',
          tokenEnv: 'FIXTURE_IMP_TOKEN',
          image: 'atc-base',
        },
      },
    ],
    (config) => ({ provider: buildStubMemoryProvider({ kind: config.provider }), problem: null }),
  );

  onTestFinished(async () => {
    for (const target of built.targets) {
      await target.provider?.dispose();
    }
  });

  const ctx = await setupTest({ targets: built.targets });

  // these are the identities a daemon stored for these targets before the providers
  // moved; the cloud row is a killed session, so its restore reaches no impd
  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-on-local'),
      cwd: ctx.dir,
      target: 'local',
      targetIdentity: 'local-pty:44136fa355b3678a',
    }),
    buildMockFleetEntry({
      sessionID: toSessionID('s-on-cloud'),
      cwd: ctx.dir,
      target: 'cloud',
      targetIdentity: 'imp:reach-v1:c97f60aac21db24e',
      exited: true,
    }),
  ]);

  await restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  expect(
    ctx.mgr.sessions.map((s) => [s.id, s.target, s.targetIdentity, s.state, s.lastMsg]),
  ).toStrictEqual([
    ['s-on-local', 'local', 'local-pty:44136fa355b3678a', 'running', 'revived'],
    ['s-on-cloud', 'cloud', 'imp:reach-v1:c97f60aac21db24e', 'exited', 'killed'],
  ]);
});

test('it refuses a stored session whose target config revision differs from the one its row was bound to', async () => {
  const built = buildExecutionTargets(
    [
      {
        id: 'cloud',
        provider: 'imp',
        options: {
          url: 'http://impd.example:7171',
          tokenEnv: 'FIXTURE_IMP_TOKEN',
          image: 'atc-base',
        },
      },
    ],
    (config) => ({ provider: buildStubMemoryProvider({ kind: config.provider }), problem: null }),
  );

  onTestFinished(async () => {
    for (const target of built.targets) {
      await target.provider?.dispose();
    }
  });

  const ctx = await setupTest({ targets: built.targets });

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-on-cloud'),
      cwd: ctx.dir,
      target: 'cloud',
      targetIdentity: 'imp:reach-v1:c97f60aac21db24e',
    }),
  ]);

  await restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  expect(ctx.mgr.sessions.map((s) => [s.id, s.state, s.lastMsg])).toStrictEqual([
    ['s-on-cloud', 'exited', "target 'cloud' changed"],
  ]);
});

test('it restores a stored session on its own target config revision after another target is added', async () => {
  const built = buildExecutionTargets(
    [
      { id: 'local', provider: 'local-pty', options: {} },
      {
        id: 'spare',
        provider: 'imp',
        options: { url: 'http://impd.example:7272', tokenEnv: 'FIXTURE_IMP_TOKEN' },
      },
    ],
    (config) => ({ provider: buildStubMemoryProvider({ kind: config.provider }), problem: null }),
  );

  onTestFinished(async () => {
    for (const target of built.targets) {
      await target.provider?.dispose();
    }
  });

  const ctx = await setupTest({ targets: built.targets });

  // the added target changes the daemon-wide revision, and the row stays
  // bound to the revision of its own target alone
  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-on-local'),
      cwd: ctx.dir,
      target: 'local',
      targetIdentity: 'local-pty:44136fa355b3678a',
    }),
  ]);

  await restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  expect(ctx.mgr.sessions.map((s) => [s.id, s.targetIdentity, s.state, s.lastMsg])).toStrictEqual([
    ['s-on-local', 'local-pty:44136fa355b3678a', 'running', 'revived'],
  ]);
});

test('it restores the fleet with no terminal for each session whose agent is not signed in on its imp', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter({ planAuthCheck: () => ['false'] }),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  mgr.log = ctx.log;

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-first'),
      cwd: ctx.dir,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
    buildMockFleetEntry({
      sessionID: toSessionID('s-second'),
      cwd: ctx.dir,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
  ]);

  const restored = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 50,
  });

  await restored.settled;

  expect(restored.restored).toBe(2);

  expect<readonly unknown[]>(mgr.sessions.map((s) => [s.id, s.pty !== null])).toStrictEqual([
    ['s-first', false],
    ['s-second', false],
  ]);
});

test('it logs a later session whose revive fails and leaves it without a terminal', async () => {
  const ctx = await setupTest();

  const planGuestSpawn = mock<NonNullable<AgentAdapter['planGuestSpawn']>>(() => ({
    bin: 'sleep',
    args: ['30'],
    files: {},
  }));

  planGuestSpawn
    .mockImplementationOnce(() => ({ bin: 'sleep', args: ['30'], files: {} }))
    .mockImplementationOnce(() => {
      throw new Error('no plan for s-second');
    });

  const mgr = new SessionManager(
    buildMockAgentAdapter({ planGuestSpawn }),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  mgr.log = ctx.log;

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-first'),
      cwd: ctx.dir,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
    buildMockFleetEntry({
      sessionID: toSessionID('s-second'),
      cwd: ctx.dir,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
  ]);

  const restored = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 50,
  });

  await restored.settled;

  expect(restored.restored).toBe(2);

  expect<readonly unknown[]>(ctx.logged).toStrictEqual([
    expect.stringMatching(/^atc: wake of session s-first on target 'box' took /u),
    'atc could not revive session s-second (no plan for s-second)',
  ]);

  expect<readonly unknown[]>(mgr.sessions.map((s) => [s.id, s.pty !== null])).toStrictEqual([
    ['s-first', true],
    ['s-second', false],
  ]);
});

test('it logs a first session whose revive fails with a plain error and still revives the next one', async () => {
  const ctx = await setupTest();

  const planGuestSpawn = mock<NonNullable<AgentAdapter['planGuestSpawn']>>(() => ({
    bin: 'sleep',
    args: ['30'],
    files: {},
  }));

  planGuestSpawn.mockImplementationOnce(() => {
    throw new Error('no plan for s-first');
  });

  const mgr = new SessionManager(
    buildMockAgentAdapter({ planGuestSpawn }),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  mgr.log = ctx.log;

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-first'),
      cwd: ctx.dir,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
    buildMockFleetEntry({
      sessionID: toSessionID('s-second'),
      cwd: ctx.dir,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
  ]);

  const restored = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 50,
  });

  await restored.settled;

  expect(restored.restored).toBe(2);

  expect<readonly unknown[]>(mgr.sessions.map((s) => [s.id, s.pty !== null])).toStrictEqual([
    ['s-first', false],
    ['s-second', true],
  ]);

  expect<readonly unknown[]>(ctx.logged).toStrictEqual([
    'atc could not revive session s-first (no plan for s-first)',
    expect.stringMatching(/^atc: wake of session s-second on target 'box' took /u),
  ]);
});

test('it lists and logs the refusal of a session whose imp refuses it with no retry left', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  mgr.log = ctx.log;

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-busy'),
      cwd: ctx.dir,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
  ]);

  ctx.impProvider.refuseNextPrepare('UNAVAILABLE');

  const restored = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 50,
    retryDelaysMs: [],
  });

  await restored.settled;

  const refusal = `imp ${ctx.impProvider.getImpName('s-busy')} cannot be used: impd refused the lease (UNAVAILABLE)`;

  expect(mgr.sessions).toMatchObject([
    { id: 's-busy', kind: 'headless', state: 'running', pty: null, lastMsg: refusal },
  ]);

  expect<readonly unknown[]>(ctx.logged).toStrictEqual([
    `atc could not revive session s-busy (${refusal})`,
  ]);
});

test('it revives a session on a later try once its imp stops refusing it', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  mgr.log = ctx.log;

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-busy'),
      cwd: ctx.dir,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
  ]);

  ctx.impProvider.refuseNextPrepare('UNAVAILABLE');

  const restored = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 50,
    retryDelaysMs: [0],
  });

  await restored.settled;

  expect(mgr.sessions).toMatchObject([{ id: 's-busy', kind: 'pty', lastMsg: 'revived' }]);

  expect<readonly unknown[]>(ctx.logged).toStrictEqual([
    `atc could not revive session s-busy (imp ${ctx.impProvider.getImpName('s-busy')} cannot be used: impd refused the lease (UNAVAILABLE)); trying again`,
    expect.stringMatching(/^atc: wake of session s-busy on target 'box' took /u),
  ]);
});

test('it waits for the last session a round started to boot before a retry starts another', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock(Date.now());

  const runtime = new SessionRuntime();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-refused'),
      cwd: ctx.dir,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
    buildMockFleetEntry({
      sessionID: toSessionID('s-booting'),
      cwd: ctx.dir,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
  ]);

  ctx.impProvider.refuseNextPrepare('UNAVAILABLE');

  const restored = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: (id) => (id === 's-booting' ? runtime : undefined),
    cols: 80,
    rows: 24,
    capMs: 0,
    retryDelaysMs: [5000],
    clock,
  });

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([1000]);
  });

  clock.advance(5000);

  await waitFor(() => {
    expect(runtime.bootWaiter).toBeFunction();
  });

  const startedBeforeBoot = ctx.impProvider.harnesses.length;

  runtime.bootWaiter?.();

  await restored.settled;

  expect(startedBeforeBoot).toBe(1);
  expect(ctx.impProvider.harnesses).toBeArrayOfSize(2);

  expect<readonly unknown[]>(mgr.sessions.map((s) => [s.id, s.pty !== null])).toStrictEqual([
    ['s-refused', true],
    ['s-booting', true],
  ]);
});

test('it leaves stopped a refused session a caller stops while its retry readies the imp', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock(Date.now());

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-busy'),
      cwd: ctx.dir,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
  ]);

  ctx.impProvider.refuseNextPrepare('UNAVAILABLE');

  const restored = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
    retryDelaysMs: [5000],
    clock,
  });

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([1000]);
  });

  ctx.impProvider.startPrepareHold();
  clock.advance(5000);

  await waitFor(() => {
    expect(ctx.impProvider.countHeldPrepares()).toBe(1);
  });

  await mgr.kill(toSessionID('s-busy'), true);

  ctx.impProvider.stopPrepareHold();

  await restored.settled;

  expect(mgr.sessions).toMatchObject([
    { id: 's-busy', state: 'exited', lastMsg: 'killed', pty: null },
  ]);

  expect(ctx.impProvider.harnesses).toStrictEqual([]);
});

test('it leaves stopped a session a caller stops while a try its imp then refuses readies the imp', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  mgr.log = ctx.log;

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-busy'),
      cwd: ctx.dir,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
  ]);

  ctx.impProvider.refuseNextPrepare('UNAVAILABLE');
  ctx.impProvider.startPrepareHold();

  const restoring = restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
    retryDelaysMs: [0],
  });

  await waitFor(() => {
    expect(ctx.impProvider.countHeldPrepares()).toBe(1);
  });

  await mgr.kill(toSessionID('s-busy'), true);

  ctx.impProvider.stopPrepareHold();

  const restored = await restoring;

  await restored.settled;

  expect(mgr.sessions).toMatchObject([
    { id: 's-busy', state: 'exited', lastMsg: 'killed', pty: null },
  ]);

  expect(ctx.impProvider.harnesses).toStrictEqual([]);

  expect<readonly unknown[]>(ctx.logged).toStrictEqual([
    `atc could not revive session s-busy (imp ${ctx.impProvider.getImpName('s-busy')} cannot be used: impd refused the lease (UNAVAILABLE))`,
  ]);
});

test('it revives on a later restore a session an earlier restore left without a terminal', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-busy'),
      cwd: ctx.dir,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
  ]);

  ctx.impProvider.refuseNextPrepare('UNAVAILABLE');

  const first = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 50,
    retryDelaysMs: [],
  });

  await first.settled;

  const restored = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 50,
    retryDelaysMs: [],
  });

  await restored.settled;

  expect(mgr.sessions).toMatchObject([{ id: 's-busy', kind: 'pty', lastMsg: 'revived' }]);
  expect(mgr.sessions).toBeArrayOfSize(1);
});

test('it never adopts a terminal for a live headless run a later restore finds listed', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  const entry = buildMockFleetEntry({
    sessionID: toSessionID('s-headless'),
    cwd: ctx.dir,
    target: 'box',
    targetIdentity: 'imp:test',
  });

  await ctx.store.writeFleet([entry]);

  const first = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 50,
    retryDelaysMs: [],
  });

  await first.settled;

  const [s] = mgr.sessions;

  invariant(s !== undefined && s.pty !== null, 'the first restore adopted no terminal');

  mgr.yankHeadless(s.id);

  const requests = ctx.impProvider.harnesses.length;

  const restored = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 50,
    retryDelaysMs: [],
  });

  await restored.settled;

  expect(ctx.impProvider.harnesses.length - requests).toBe(0);
  expect(mgr.sessions).toMatchObject([{ id: 's-headless', kind: 'headless', pty: null }]);
});

test('it restores and persists a live legacy cloud session after an image change', async () => {
  const options = { url: 'http://impd', image: 'new' };
  const identity = buildTargetIdentity('imp', options);

  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'cloud', kind: 'imp', options, identity, provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  const entry = buildMockFleetEntry({
    cwd: ctx.dir,
    target: 'cloud',
    targetIdentity: 'imp:0123456789abcdef',
  });

  ctx.impProvider.createHost(entry.sessionID);

  await ctx.store.writeFleet([entry]);

  const restored = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  await restored.settled;

  await mgr.writeFleet();

  expect(restored.restored).toBe(1);

  expect(mgr.sessions).toMatchObject([
    {
      id: entry.sessionID,
      targetIdentity: identity,
      state: 'running',
    },
  ]);

  expect(mgr.sessions[0]?.pty?.detach).toBeFunction();

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toMatchObject([{ sessionID: entry.sessionID, targetIdentity: identity }]);
  expect(ctx.impProvider.created).toStrictEqual([]);
});

test('it keeps a cloud session usable after the image changes under a versioned binding', async () => {
  const options = { url: 'http://impd', image: 'new' };
  const identity = buildTargetIdentity('imp', options);

  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'cloud', kind: 'imp', options, identity, provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  const entry = buildMockFleetEntry({
    cwd: ctx.dir,
    target: 'cloud',
    targetIdentity: buildTargetIdentity('imp', { url: 'http://impd', image: 'old' }),
  });

  ctx.impProvider.createHost(entry.sessionID);

  await ctx.store.writeFleet([entry]);

  const restored = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  await restored.settled;

  expect(mgr.sessions).toMatchObject([{ id: entry.sessionID, state: 'running' }]);
  expect(mgr.sessions[0]?.pty?.detach).toBeFunction();

  expect(
    mgr.findExecutionRefusal(
      { target: 'cloud', targetIdentity: entry.targetIdentity ?? null },
      'input',
    ),
  ).toBeNull();
});

test('it leaves a missing legacy imp refused instead of creating a replacement', async () => {
  const options = { url: 'http://impd', image: 'new' };
  const identity = buildTargetIdentity('imp', options);

  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'cloud', kind: 'imp', options, identity, provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  const entry = buildMockFleetEntry({
    cwd: ctx.dir,
    target: 'cloud',
    targetIdentity: 'imp:0123456789abcdef',
  });

  await ctx.store.writeFleet([entry]);

  const restored = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  await restored.settled;

  expect(mgr.sessions).toMatchObject([
    {
      id: entry.sessionID,
      targetIdentity: 'imp:0123456789abcdef',
      state: 'exited',
      pty: null,
      lastMsg: "target 'cloud' binding unverified",
    },
  ]);

  expect(ctx.impProvider.prepared).toStrictEqual([]);
});

test('it restores a listed legacy session when its imp becomes reachable on a later restore', async () => {
  const options = { url: 'http://impd', image: 'new' };
  const identity = buildTargetIdentity('imp', options);

  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'cloud', kind: 'imp', options, identity, provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  const entry = buildMockFleetEntry({
    cwd: ctx.dir,
    target: 'cloud',
    targetIdentity: 'imp:0123456789abcdef',
  });

  await ctx.store.writeFleet([entry]);

  const first = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  await first.settled;

  const refused = mgr.sessions[0]?.lastMsg;

  ctx.impProvider.createHost(entry.sessionID);

  const restored = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  await restored.settled;

  expect(refused).toBe("target 'cloud' binding unverified");

  expect(mgr.sessions).toMatchObject([
    { id: entry.sessionID, targetIdentity: identity, state: 'running' },
  ]);

  expect(mgr.sessions).toBeArrayOfSize(1);
  expect(mgr.sessions[0]?.pty?.detach).toBeFunction();
});

test('it lists the adoption refusal in place of a stale binding refusal once the host check succeeds', async () => {
  const options = { url: 'http://impd', image: 'new' };
  const identity = buildTargetIdentity('imp', options);

  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'cloud', kind: 'imp', options, identity, provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  const entry = buildMockFleetEntry({
    cwd: ctx.dir,
    target: 'cloud',
    targetIdentity: 'imp:0123456789abcdef',
  });

  await ctx.store.writeFleet([entry]);

  const first = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  await first.settled;

  ctx.impProvider.createHost(entry.sessionID);
  ctx.impProvider.refuseNextPrepare('LEASED');

  const restored = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
    retryDelaysMs: [],
  });

  await restored.settled;

  expect(mgr.sessions).toMatchObject([
    {
      id: entry.sessionID,
      targetIdentity: identity,
      state: 'exited',
      lastMsg: `imp ${ctx.impProvider.getImpName(entry.sessionID)} cannot be used: impd refused the lease (LEASED)`,
    },
  ]);
});

test('it starts no harness once the daemon stopped before the restore began', async () => {
  const ctx = await setupTest();

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
        provider: ctx.held,
      },
    ],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: ctx.dir }),
    buildMockFleetEntry({ sessionID: toSessionID('s-b'), cwd: ctx.dir }),
    buildMockFleetEntry({ sessionID: toSessionID('s-c'), cwd: ctx.dir }),
  ]);

  const result = await restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
    isStopped: () => true,
  });

  const outcome = await result.settled;

  expect(result.restored).toBe(3);
  expect(outcome).toBe('stopped');
  expect(ctx.held.prepared.map((request) => request.host)).toStrictEqual([]);
  expect(ctx.held.harnesses).toStrictEqual([]);
});

test('it starts no harness once the daemon stops while the first one starts', async () => {
  const ctx = await setupTest();

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
        provider: ctx.held,
      },
    ],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: ctx.dir }),
    buildMockFleetEntry({ sessionID: toSessionID('s-b'), cwd: ctx.dir }),
    buildMockFleetEntry({ sessionID: toSessionID('s-c'), cwd: ctx.dir }),
  ]);

  let stopped = false;

  const restoring = restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
    isStopped: () => stopped,
  });

  await waitFor(() => {
    expect(ctx.held.prepared.map((request) => request.host)).toStrictEqual(['s-a']);
  });

  stopped = true;

  ctx.release('s-a');

  const result = await restoring;
  const outcome = await result.settled;

  expect(outcome).toBe('stopped');
  expect(ctx.held.prepared.map((request) => request.host)).toStrictEqual(['s-a']);
  expect(ctx.held.harnesses).toStrictEqual([]);
});

test('it starts no harness for a queued session once the daemon stops during its start', async () => {
  const ctx = await setupTest();

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
        provider: ctx.held,
      },
    ],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: ctx.dir }),
    buildMockFleetEntry({ sessionID: toSessionID('s-b'), cwd: ctx.dir }),
    buildMockFleetEntry({ sessionID: toSessionID('s-c'), cwd: ctx.dir }),
  ]);

  let stopped = false;

  const restoring = restoreFleet({
    mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
    isStopped: () => stopped,
  });

  await waitFor(() => {
    expect(ctx.held.prepared.map((request) => request.host)).toStrictEqual(['s-a']);
  });

  ctx.release('s-a');

  const result = await restoring;

  await waitFor(() => {
    expect(ctx.held.prepared.map((request) => request.host)).toStrictEqual(['s-a', 's-b']);
  });

  ctx.release('s-b');

  await waitFor(() => {
    expect(ctx.held.prepared.map((request) => request.host)).toStrictEqual(['s-a', 's-b', 's-c']);
  });

  stopped = true;

  ctx.release('s-c');

  const outcome = await result.settled;

  expect(outcome).toBe('stopped');
  expect(ctx.held.harnesses.map((harness) => harness.spec.session)).toStrictEqual(['s-a', 's-b']);
});
