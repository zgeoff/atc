import { expect, mock, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import type { SessionID } from '@atc/core';
import { toAgentSessionID, toSessionID } from '@atc/core';
import type { AgentAdapter } from '@atc/plugin-api';
import { buildTargetIdentity, createStateStore } from '@atc/store';
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
import { createSessionManager } from '../sessions/create-session-manager';
import { createSessionRuntime } from '../sessions/create-session-runtime';
import type { SessionRuntime } from '../sessions/create-session-runtime';
import type { Session } from '../sessions/session';
import { startHeadlessTurn } from '../sessions/start-headless-turn';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { buildStubRestoreImpProvider } from '../testing/build-stub-restore-imp-provider';
import { runLocalCommand } from '../testing/run-local-command';
import type { ExecutionTarget } from './build-execution-targets';
import { buildExecutionTargets } from './build-execution-targets';
import { restoreFleet } from './restore-fleet';

async function setupTest(config: Readonly<{ targets?: readonly ExecutionTarget[] }> = {}) {
  const temporaryDirectory = setupTempDir('atc-restore-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

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
  const statusPath = join(temporaryDirectory.path, 'status.json');

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

  const manager = createSessionManager(buildMockAgentAdapter(), store, statusPath, [], targets);

  registerTestCleanup(() => {
    manager.detachAll();
  });

  // no session holds a runtime, so a stagger waits on no boot
  const runtimes = new Map<SessionID, SessionRuntime>();

  return {
    directory: temporaryDirectory.path,
    statusPath,
    store,
    impProvider,
    held,
    release: (host: string) => {
      heldPrepares.get(host)?.resolve();
    },
    targets,
    manager,
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
      cwd: ctx.directory,
      agentSessionID: toAgentSessionID('c-kept'),
    }),
  ]);

  const restored = await restoreFleet({
    manager: ctx.manager,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  expect(restored.restored).toBe(1);
  expect(ctx.manager.sessions.map((session) => session.id)).toStrictEqual([toSessionID('s-kept')]);
});

test('it revives a listed dead session in place instead of listing its id twice', async () => {
  const ctx = await setupTest();

  const session = await ctx.manager.spawn(
    ctx.directory,
    'worker',
    '',
    80,
    24,
    toAgentSessionID('c-1'),
  );

  await ctx.manager.writeFleet();

  session.pty?.kill();

  await waitFor(() => {
    expect(session.state).toBe('exited');
  });

  const exitedPTY = session.pty;

  await restoreFleet({
    manager: ctx.manager,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  expect(ctx.manager.sessions.map((x) => x.id)).toStrictEqual([session.id]);
  expect(exitedPTY).toBeNull();
  expect(session.pty).not.toBeNull();
});

test('it keeps a sub-session under the session that resumed its parent agent session', async () => {
  const ctx = await setupTest();

  // the next daemon life, over the same store
  const restarted = createSessionManager(
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
      expect(restarted.sessions).toSatisfyAll((session: Session) => session.pty !== null);
    });

    await restarted.writeFleet();
  });

  const parent = ctx.manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-parent'),
      name: 'wrangler',
      cwd: ctx.directory,
      agentSessionID: toAgentSessionID('c-parent'),
      exited: true,
    }),
  );

  const child = await ctx.manager.spawn(
    ctx.directory,
    'worker',
    '',
    80,
    24,
    toAgentSessionID('c-child'),
    'user',
    'claude',
    parent.id,
  );

  const resumed = await ctx.manager.spawn(
    ctx.directory,
    'wrangler',
    '',
    80,
    24,
    toAgentSessionID('c-parent'),
  );

  await ctx.manager.writeFleet();

  await restoreFleet({
    manager: restarted,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  const restoredChild = restarted.sessions.find((session) => session.id === child.id);

  expect(restoredChild?.parent).toBe(resumed.id);
});

test('it keeps a sub-session under a sub-session that resumed their parent agent session', async () => {
  const ctx = await setupTest();

  // the next daemon life, over the same store
  const restarted = createSessionManager(
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
      expect(restarted.sessions).toSatisfyAll((session: Session) => session.pty !== null);
    });

    await restarted.writeFleet();
  });

  const parent = ctx.manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-parent'),
      name: 'wrangler',
      cwd: ctx.directory,
      agentSessionID: toAgentSessionID('c-parent'),
      exited: true,
    }),
  );

  const child = await ctx.manager.spawn(
    ctx.directory,
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
  const resumed = await ctx.manager.spawn(
    ctx.directory,
    'wrangler',
    '',
    80,
    24,
    toAgentSessionID('c-parent'),
    'user',
    'claude',
    parent.id,
  );

  await ctx.manager.writeFleet();

  await restoreFleet({
    manager: restarted,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  const restored = restarted.sessions.map((session) => [session.id, session.parent]);

  expect(restored).toIncludeSameMembers([
    [child.id, resumed.id],
    [resumed.id, null],
  ]);
});

test('it restores two crossed resumes with the earlier one top-level and the later one under it', async () => {
  const ctx = await setupTest();

  // the next daemon life, over the same store
  const restarted = createSessionManager(
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
      expect(restarted.sessions).toSatisfyAll((session: Session) => session.pty !== null);
    });

    await restarted.writeFleet();
  });

  const first = ctx.manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-p'),
      name: 'p',
      cwd: ctx.directory,
      agentSessionID: toAgentSessionID('c-a'),
      exited: true,
    }),
  );

  const second = ctx.manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-q'),
      name: 'q',
      cwd: ctx.directory,
      agentSessionID: toAgentSessionID('c-b'),
      exited: true,
    }),
  );

  const resumedFirst = await ctx.manager.spawn(
    ctx.directory,
    'r',
    '',
    80,
    24,
    toAgentSessionID('c-a'),
    'user',
    'claude',
    second.id,
  );

  const resumedSecond = await ctx.manager.spawn(
    ctx.directory,
    's',
    '',
    80,
    24,
    toAgentSessionID('c-b'),
    'user',
    'claude',
    first.id,
  );

  await ctx.manager.writeFleet();

  await restoreFleet({
    manager: restarted,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  const restored = restarted.sessions.map((session) => [session.id, session.parent]);

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

  const manager = createSessionManager(
    buildMockAgentAdapter({ planSpawn, headlessRunner: headless.runner }),
    ctx.store,
    ctx.statusPath,
    [],
    ctx.targets,
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-headless'),
      cwd: ctx.directory,
      agentSessionID: toAgentSessionID('c-headless'),
    }),
  ]);

  const first = await restoreFleet({
    manager,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
    retryDelaysMs: [],
  });

  await first.settled;

  const runtime = createSessionRuntime();

  const started = startHeadlessTurn(
    manager,
    () => runtime,
    toSessionID('s-headless'),
    'keep going',
    () => {},
    join(ctx.directory, 'reporter.sock'),
  );

  invariant(started, 'the headless turn did not start');

  const restored = await restoreFleet({
    manager,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
    retryDelaysMs: [],
  });

  await restored.settled;

  expect(planSpawn).toHaveBeenCalledOnce();
  expect(manager.sessions).toMatchObject([{ id: 's-headless', kind: 'headless', pty: null }]);
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

  const manager = createSessionManager(
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
    manager.detachAll();
  });

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-headless'),
      cwd: ctx.directory,
      agentSessionID: toAgentSessionID('c-headless'),
    }),
  ]);

  const first = await restoreFleet({
    manager,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
    retryDelaysMs: [],
  });

  await first.settled;

  const runtime = createSessionRuntime();

  expect(() =>
    startHeadlessTurn(
      manager,
      () => runtime,
      toSessionID('s-headless'),
      'keep going',
      () => {},
      join(ctx.directory, 'reporter.sock'),
    ),
  ).toThrowWithMessage(Error, 'the settings file cannot be written');

  const restored = await restoreFleet({
    manager,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
    retryDelaysMs: [],
  });

  await restored.settled;

  expect(manager.sessions).toMatchObject([{ id: 's-headless', kind: 'pty', lastMsg: 'revived' }]);
});

test('it starts no terminal for a queued session whose headless turn starts while the restore waits on an earlier session', async () => {
  const ctx = await setupTest();

  const planSpawn = mock<AgentAdapter['planSpawn']>(() => ({
    bin: 'sleep',
    args: ['30'],
  }));

  const headless = buildStubHeadlessRunner();

  const manager = createSessionManager(
    buildMockAgentAdapter({ planSpawn, headlessRunner: headless.runner }),
    ctx.store,
    ctx.statusPath,
    [],
    ctx.targets,
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-first'),
      cwd: ctx.directory,
      agentSessionID: toAgentSessionID('c-first'),
    }),
    buildMockFleetEntry({
      sessionID: toSessionID('s-second'),
      cwd: ctx.directory,
      agentSessionID: toAgentSessionID('c-second'),
    }),
  ]);

  // The first session never reports it has booted, so the restore waits on
  // it until the test releases the wait.
  const firstRuntime = createSessionRuntime();

  const restored = await restoreFleet({
    manager,
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
    manager,
    () => createSessionRuntime(),
    toSessionID('s-second'),
    'keep going',
    () => {},
    join(ctx.directory, 'reporter.sock'),
  );

  invariant(started, 'the headless turn did not start');
  firstRuntime.bootWaiter?.();

  const outcome = await restored.settled;

  expect(outcome).toBe('finished');
  expect(planSpawn).toHaveBeenCalledOnce();

  expect(manager.sessions).toMatchObject([
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
    (config) => ({
      provider: buildStubMemoryProvider({ kind: config.provider }),
      problem: null,
      identityRule: new Map([
        [
          'imp',
          {
            version: 'reach-v1',
            ignoredOptions: ['image', 'memoryMib', 'guestATC', 'rebindChangedAuth'],
          },
        ],
      ]).get(config.provider),
    }),
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
      cwd: ctx.directory,
      target: 'local',
      targetIdentity: 'local-pty:44136fa355b3678a',
    }),
    buildMockFleetEntry({
      sessionID: toSessionID('s-on-cloud'),
      cwd: ctx.directory,
      target: 'cloud',
      targetIdentity: 'imp:reach-v1:c97f60aac21db24e',
      exited: true,
    }),
  ]);

  await restoreFleet({
    manager: ctx.manager,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  expect(
    ctx.manager.sessions.map((session) => [
      session.id,
      session.target,
      session.targetIdentity,
      session.state,
      session.lastMsg,
    ]),
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
    (config) => ({
      provider: buildStubMemoryProvider({ kind: config.provider }),
      problem: null,
      identityRule: new Map([
        [
          'imp',
          {
            version: 'reach-v1',
            ignoredOptions: ['image', 'memoryMib', 'guestATC', 'rebindChangedAuth'],
          },
        ],
      ]).get(config.provider),
    }),
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
      cwd: ctx.directory,
      target: 'cloud',
      targetIdentity: 'imp:reach-v1:c97f60aac21db24e',
    }),
  ]);

  await restoreFleet({
    manager: ctx.manager,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  expect(
    ctx.manager.sessions.map((session) => [session.id, session.state, session.lastMsg]),
  ).toStrictEqual([['s-on-cloud', 'exited', "target 'cloud' changed"]]);
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
    (config) => ({
      provider: buildStubMemoryProvider({ kind: config.provider }),
      problem: null,
      identityRule: new Map([
        [
          'imp',
          {
            version: 'reach-v1',
            ignoredOptions: ['image', 'memoryMib', 'guestATC', 'rebindChangedAuth'],
          },
        ],
      ]).get(config.provider),
    }),
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
      cwd: ctx.directory,
      target: 'local',
      targetIdentity: 'local-pty:44136fa355b3678a',
    }),
  ]);

  await restoreFleet({
    manager: ctx.manager,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  expect(
    ctx.manager.sessions.map((session) => [
      session.id,
      session.targetIdentity,
      session.state,
      session.lastMsg,
    ]),
  ).toStrictEqual([['s-on-local', 'local-pty:44136fa355b3678a', 'running', 'revived']]);
});

test('it restores the fleet with no terminal for each session whose agent is not signed in on its imp', async () => {
  const ctx = await setupTest();

  const manager = createSessionManager(
    buildMockAgentAdapter({ planAuthCheck: () => ['false'] }),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  manager.log = ctx.log;

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-first'),
      cwd: ctx.directory,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
    buildMockFleetEntry({
      sessionID: toSessionID('s-second'),
      cwd: ctx.directory,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
  ]);

  const restored = await restoreFleet({
    manager,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 50,
  });

  await restored.settled;

  expect(restored.restored).toBe(2);

  expect<readonly unknown[]>(
    manager.sessions.map((session) => [session.id, session.pty !== null]),
  ).toStrictEqual([
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

  const manager = createSessionManager(
    buildMockAgentAdapter({ planGuestSpawn }),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  manager.log = ctx.log;

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-first'),
      cwd: ctx.directory,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
    buildMockFleetEntry({
      sessionID: toSessionID('s-second'),
      cwd: ctx.directory,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
  ]);

  const restored = await restoreFleet({
    manager,
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

  expect<readonly unknown[]>(
    manager.sessions.map((session) => [session.id, session.pty !== null]),
  ).toStrictEqual([
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

  const manager = createSessionManager(
    buildMockAgentAdapter({ planGuestSpawn }),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  manager.log = ctx.log;

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-first'),
      cwd: ctx.directory,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
    buildMockFleetEntry({
      sessionID: toSessionID('s-second'),
      cwd: ctx.directory,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
  ]);

  const restored = await restoreFleet({
    manager,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 50,
  });

  await restored.settled;

  expect(restored.restored).toBe(2);

  expect<readonly unknown[]>(
    manager.sessions.map((session) => [session.id, session.pty !== null]),
  ).toStrictEqual([
    ['s-first', false],
    ['s-second', true],
  ]);

  expect<readonly unknown[]>(ctx.logged).toStrictEqual([
    'atc could not revive session s-first (no plan for s-first)',
    expect.stringMatching(/^atc: wake of session s-second on target 'box' took /u),
  ]);
});

test("it lists the plugin refusal of a session on a remote target once its agent's config sets plugin folders, and still revives a local session", async () => {
  const ctx = await setupTest();

  const local = buildStubMemoryProvider({ kind: 'local-pty' });
  const remote = buildStubMemoryProvider({ kind: 'imp-like', remote: true });

  const manager = createSessionManager(
    buildMockAgentAdapter({
      profile: {
        label: 'Claude',
        kind: 'claude',
        bin: 'sh',
        models: null,
        spawnOptions: {
          model: {
            supported: false,
            values: null,
            examples: [],
            default: null,
            backendEffect: null,
            note: null,
          },
          effort: {
            supported: false,
            values: null,
            examples: [],
            default: null,
            backendEffect: null,
            note: null,
          },
        },
        pluginDirs: [ctx.directory],
      },
    }),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: local,
      },
      { id: 'box', kind: 'imp-like', options: {}, identity: 'imp-like:test', provider: remote },
    ],
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  manager.log = ctx.log;

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-remote'),
      cwd: '/work',
      agentSessionID: toAgentSessionID('c-remote'),
      target: 'box',
      targetIdentity: 'imp-like:test',
    }),
    buildMockFleetEntry({
      sessionID: toSessionID('s-local'),
      cwd: ctx.directory,
      agentSessionID: toAgentSessionID('c-local'),
    }),
  ]);

  const restored = await restoreFleet({
    manager,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
    retryDelaysMs: [],
  });

  await restored.settled;

  const refusal =
    "target 'box' runs the agent on another machine, so it takes no pluginDirs; the agent's config or the spawn sets them";

  expect(manager.sessions.find((session) => session.id === toSessionID('s-remote'))).toMatchObject({
    pty: null,
    lastMsg: refusal,
    restoreRefusal: { code: 'unsupported', message: refusal },
  });

  expect<readonly unknown[]>(ctx.logged).toStrictEqual([
    `atc could not revive session s-remote (${refusal})`,
  ]);

  expect(manager.sessions.find((session) => session.id === toSessionID('s-local'))).toMatchObject({
    kind: 'pty',
    pty: local.harnesses[0],
  });

  expect(remote.harnesses).toStrictEqual([]);
});

test("it lists the plugin refusal of a local session whose agent's configured plugin folder is gone", async () => {
  const ctx = await setupTest();

  const local = buildStubMemoryProvider({ kind: 'local-pty' });

  const manager = createSessionManager(
    buildMockAgentAdapter({
      profile: {
        label: 'Claude',
        kind: 'claude',
        bin: 'sh',
        models: null,
        spawnOptions: {
          model: {
            supported: false,
            values: null,
            examples: [],
            default: null,
            backendEffect: null,
            note: null,
          },
          effort: {
            supported: false,
            values: null,
            examples: [],
            default: null,
            backendEffect: null,
            note: null,
          },
        },
        pluginDirs: ['/nonexistent/plugins/shared'],
      },
    }),
    ctx.store,
    ctx.statusPath,
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: local,
      },
    ],
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  manager.log = ctx.log;

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-local'),
      cwd: ctx.directory,
      agentSessionID: toAgentSessionID('c-local'),
    }),
  ]);

  const restored = await restoreFleet({
    manager,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
    retryDelaysMs: [],
  });

  await restored.settled;

  const refusal = "plugin folder '/nonexistent/plugins/shared' does not exist";

  expect(manager.sessions).toMatchObject([
    {
      id: 's-local',
      pty: null,
      lastMsg: refusal,
      restoreRefusal: { code: 'bad_args', message: refusal },
    },
  ]);

  expect(local.harnesses).toStrictEqual([]);
});

test('it lists and logs the refusal of a session whose imp refuses it with no retry left', async () => {
  const ctx = await setupTest();

  const manager = createSessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  manager.log = ctx.log;

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-busy'),
      cwd: ctx.directory,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
  ]);

  ctx.impProvider.refuseNextPrepare('UNAVAILABLE');

  const restored = await restoreFleet({
    manager,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 50,
    retryDelaysMs: [],
  });

  await restored.settled;

  const refusal = `imp ${ctx.impProvider.getImpName('s-busy')} cannot be used: impd refused the lease (UNAVAILABLE)`;

  expect(manager.sessions).toMatchObject([
    { id: 's-busy', kind: 'headless', state: 'running', pty: null, lastMsg: refusal },
  ]);

  expect<readonly unknown[]>(ctx.logged).toStrictEqual([
    `atc could not revive session s-busy (${refusal})`,
  ]);
});

test('it revives a session on a later try once its imp stops refusing it', async () => {
  const ctx = await setupTest();

  const manager = createSessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  manager.log = ctx.log;

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-busy'),
      cwd: ctx.directory,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
  ]);

  ctx.impProvider.refuseNextPrepare('UNAVAILABLE');

  const restored = await restoreFleet({
    manager,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 50,
    retryDelaysMs: [0],
  });

  await restored.settled;

  expect(manager.sessions).toMatchObject([{ id: 's-busy', kind: 'pty', lastMsg: 'revived' }]);

  expect<readonly unknown[]>(ctx.logged).toStrictEqual([
    `atc could not revive session s-busy (imp ${ctx.impProvider.getImpName('s-busy')} cannot be used: impd refused the lease (UNAVAILABLE)); trying again`,
    expect.stringMatching(/^atc: wake of session s-busy on target 'box' took /u),
  ]);
});

test('it waits for the last session a round started to boot before a retry starts another', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock(Date.now());
  const runtime = createSessionRuntime();

  const manager = createSessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-refused'),
      cwd: ctx.directory,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
    buildMockFleetEntry({
      sessionID: toSessionID('s-booting'),
      cwd: ctx.directory,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
  ]);

  ctx.impProvider.refuseNextPrepare('UNAVAILABLE');

  const restored = await restoreFleet({
    manager,
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

  expect<readonly unknown[]>(
    manager.sessions.map((session) => [session.id, session.pty !== null]),
  ).toStrictEqual([
    ['s-refused', true],
    ['s-booting', true],
  ]);
});

test('it leaves stopped a refused session a caller stops while its retry readies the imp', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock(Date.now());

  const manager = createSessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-busy'),
      cwd: ctx.directory,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
  ]);

  ctx.impProvider.refuseNextPrepare('UNAVAILABLE');

  const restored = await restoreFleet({
    manager,
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

  await manager.kill(toSessionID('s-busy'), true);

  ctx.impProvider.stopPrepareHold();

  await restored.settled;

  expect(manager.sessions).toMatchObject([
    { id: 's-busy', state: 'exited', lastMsg: 'killed', pty: null },
  ]);

  expect(ctx.impProvider.harnesses).toStrictEqual([]);
});

test('it leaves stopped a session a caller stops while a try its imp then refuses readies the imp', async () => {
  const ctx = await setupTest();

  const manager = createSessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  manager.log = ctx.log;

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-busy'),
      cwd: ctx.directory,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
  ]);

  ctx.impProvider.refuseNextPrepare('UNAVAILABLE');
  ctx.impProvider.startPrepareHold();

  const restoring = restoreFleet({
    manager,
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

  await manager.kill(toSessionID('s-busy'), true);

  ctx.impProvider.stopPrepareHold();

  const restored = await restoring;

  await restored.settled;

  expect(manager.sessions).toMatchObject([
    { id: 's-busy', state: 'exited', lastMsg: 'killed', pty: null },
  ]);

  expect(ctx.impProvider.harnesses).toStrictEqual([]);

  expect<readonly unknown[]>(ctx.logged).toStrictEqual([
    `atc could not revive session s-busy (imp ${ctx.impProvider.getImpName('s-busy')} cannot be used: impd refused the lease (UNAVAILABLE))`,
  ]);
});

test('it revives on a later restore a session an earlier restore left without a terminal', async () => {
  const ctx = await setupTest();

  const manager = createSessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-busy'),
      cwd: ctx.directory,
      target: 'box',
      targetIdentity: 'imp:test',
    }),
  ]);

  ctx.impProvider.refuseNextPrepare('UNAVAILABLE');

  const first = await restoreFleet({
    manager,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 50,
    retryDelaysMs: [],
  });

  await first.settled;

  const restored = await restoreFleet({
    manager,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 50,
    retryDelaysMs: [],
  });

  await restored.settled;

  expect(manager.sessions).toMatchObject([{ id: 's-busy', kind: 'pty', lastMsg: 'revived' }]);
  expect(manager.sessions).toBeArrayOfSize(1);
});

test('it never adopts a terminal for a live headless run a later restore finds listed', async () => {
  const ctx = await setupTest();

  const manager = createSessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.impProvider }],
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  const entry = buildMockFleetEntry({
    sessionID: toSessionID('s-headless'),
    cwd: ctx.directory,
    target: 'box',
    targetIdentity: 'imp:test',
  });

  await ctx.store.writeFleet([entry]);

  const first = await restoreFleet({
    manager,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 50,
    retryDelaysMs: [],
  });

  await first.settled;

  const [session] = manager.sessions;

  invariant(session !== undefined && session.pty !== null, 'the first restore adopted no terminal');

  manager.yankHeadless(session.id);

  const requests = ctx.impProvider.harnesses.length;

  const restored = await restoreFleet({
    manager,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 50,
    retryDelaysMs: [],
  });

  await restored.settled;

  expect(ctx.impProvider.harnesses.length - requests).toBe(0);
  expect(manager.sessions).toMatchObject([{ id: 's-headless', kind: 'headless', pty: null }]);
});

test('it restores and persists a live legacy cloud session after an image change', async () => {
  const options = { url: 'http://impd', image: 'new' };
  const identityRule = { version: 'reach-v1', ignoredOptions: ['image'] };
  const identity = buildTargetIdentity('imp', options, identityRule);

  const ctx = await setupTest();

  const manager = createSessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      buildMockExecutionTarget({
        id: 'cloud',
        kind: 'imp',
        options,
        identity,
        identityRule,
        provider: ctx.impProvider,
      }),
    ],
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  const entry = buildMockFleetEntry({
    cwd: ctx.directory,
    target: 'cloud',
    targetIdentity: 'imp:0123456789abcdef',
  });

  ctx.impProvider.createHost(entry.sessionID);

  await ctx.store.writeFleet([entry]);

  const restored = await restoreFleet({
    manager,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  await restored.settled;

  await manager.writeFleet();

  expect(restored.restored).toBe(1);

  expect(manager.sessions).toMatchObject([
    {
      id: entry.sessionID,
      targetIdentity: identity,
      state: 'running',
    },
  ]);

  expect(manager.sessions[0]?.pty?.detach).toBeFunction();

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toMatchObject([{ sessionID: entry.sessionID, targetIdentity: identity }]);
  expect(ctx.impProvider.created).toStrictEqual([]);
});

test('it keeps a cloud session usable after the image changes under a versioned binding', async () => {
  const options = { url: 'http://impd', image: 'new' };
  const identityRule = { version: 'reach-v1', ignoredOptions: ['image'] };
  const identity = buildTargetIdentity('imp', options, identityRule);

  const ctx = await setupTest();

  const manager = createSessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      buildMockExecutionTarget({
        id: 'cloud',
        kind: 'imp',
        options,
        identity,
        identityRule,
        provider: ctx.impProvider,
      }),
    ],
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  const entry = buildMockFleetEntry({
    cwd: ctx.directory,
    target: 'cloud',
    targetIdentity: buildTargetIdentity('imp', { url: 'http://impd', image: 'old' }, identityRule),
  });

  ctx.impProvider.createHost(entry.sessionID);

  await ctx.store.writeFleet([entry]);

  const restored = await restoreFleet({
    manager,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  await restored.settled;

  expect(manager.sessions).toMatchObject([{ id: entry.sessionID, state: 'running' }]);
  expect(manager.sessions[0]?.pty?.detach).toBeFunction();

  expect(
    manager.findExecutionRefusal(
      { target: 'cloud', targetIdentity: entry.targetIdentity ?? null },
      'input',
    ),
  ).toBeNull();
});

test('it leaves a missing legacy imp refused instead of creating a replacement', async () => {
  const options = { url: 'http://impd', image: 'new' };
  const identityRule = { version: 'reach-v1', ignoredOptions: ['image'] };
  const identity = buildTargetIdentity('imp', options, identityRule);

  const ctx = await setupTest();

  const manager = createSessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      buildMockExecutionTarget({
        id: 'cloud',
        kind: 'imp',
        options,
        identity,
        identityRule,
        provider: ctx.impProvider,
      }),
    ],
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  const entry = buildMockFleetEntry({
    cwd: ctx.directory,
    target: 'cloud',
    targetIdentity: 'imp:0123456789abcdef',
  });

  await ctx.store.writeFleet([entry]);

  const restored = await restoreFleet({
    manager,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  await restored.settled;

  expect(manager.sessions).toMatchObject([
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
  const identityRule = { version: 'reach-v1', ignoredOptions: ['image'] };
  const identity = buildTargetIdentity('imp', options, identityRule);

  const ctx = await setupTest();

  const manager = createSessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      buildMockExecutionTarget({
        id: 'cloud',
        kind: 'imp',
        options,
        identity,
        identityRule,
        provider: ctx.impProvider,
      }),
    ],
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  const entry = buildMockFleetEntry({
    cwd: ctx.directory,
    target: 'cloud',
    targetIdentity: 'imp:0123456789abcdef',
  });

  await ctx.store.writeFleet([entry]);

  const first = await restoreFleet({
    manager,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  await first.settled;

  const refused = manager.sessions[0]?.lastMsg;

  ctx.impProvider.createHost(entry.sessionID);

  const restored = await restoreFleet({
    manager,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  await restored.settled;

  expect(refused).toBe("target 'cloud' binding unverified");

  expect(manager.sessions).toMatchObject([
    { id: entry.sessionID, targetIdentity: identity, state: 'running' },
  ]);

  expect(manager.sessions).toBeArrayOfSize(1);
  expect(manager.sessions[0]?.pty?.detach).toBeFunction();
});

test('it lists the adoption refusal in place of a stale binding refusal once the host check succeeds', async () => {
  const options = { url: 'http://impd', image: 'new' };
  const identityRule = { version: 'reach-v1', ignoredOptions: ['image'] };
  const identity = buildTargetIdentity('imp', options, identityRule);

  const ctx = await setupTest();

  const manager = createSessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      buildMockExecutionTarget({
        id: 'cloud',
        kind: 'imp',
        options,
        identity,
        identityRule,
        provider: ctx.impProvider,
      }),
    ],
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  const entry = buildMockFleetEntry({
    cwd: ctx.directory,
    target: 'cloud',
    targetIdentity: 'imp:0123456789abcdef',
  });

  await ctx.store.writeFleet([entry]);

  const first = await restoreFleet({
    manager,
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
    manager,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
    retryDelaysMs: [],
  });

  await restored.settled;

  expect(manager.sessions).toMatchObject([
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

  const manager = createSessionManager(
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
    manager.detachAll();
  });

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: ctx.directory }),
    buildMockFleetEntry({ sessionID: toSessionID('s-b'), cwd: ctx.directory }),
    buildMockFleetEntry({ sessionID: toSessionID('s-c'), cwd: ctx.directory }),
  ]);

  const result = await restoreFleet({
    manager,
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

  const manager = createSessionManager(
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
    manager.detachAll();
  });

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: ctx.directory }),
    buildMockFleetEntry({ sessionID: toSessionID('s-b'), cwd: ctx.directory }),
    buildMockFleetEntry({ sessionID: toSessionID('s-c'), cwd: ctx.directory }),
  ]);

  let stopped = false;

  const restoring = restoreFleet({
    manager,
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

  const manager = createSessionManager(
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
    manager.detachAll();
  });

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: ctx.directory }),
    buildMockFleetEntry({ sessionID: toSessionID('s-b'), cwd: ctx.directory }),
    buildMockFleetEntry({ sessionID: toSessionID('s-c'), cwd: ctx.directory }),
  ]);

  let stopped = false;

  const restoring = restoreFleet({
    manager,
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
