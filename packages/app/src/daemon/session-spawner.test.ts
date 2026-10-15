import { expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock, toSessionID } from '@atc/core';
import { LocalPTYProvider } from '@atc/execution-local';
import type { AgentAdapter } from '@atc/plugin-api';
import { EffectRemainsError } from '@atc/plugin-api';
import { StateStore } from '@atc/store';
import { createMigratedStateDB } from '@atc/store/testing';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { buildMockExecutionTarget } from '../test-utils/build-mock-execution-target';
import { buildMockSession } from '../test-utils/build-mock-session';
import { AuthSetup } from './auth-setup';
import type { ExecutionTarget } from './build-execution-targets';
import { HostDirClaims } from './host-dir-claims';
import { PublishedRecords } from './published-records';
import { runSpawnSteps } from './run-spawn-steps';
import type { SpawnStepName, SpawnStepRunner } from './run-spawn-steps';
import type { SessionCallbacks } from './session-callbacks';
import { SessionFleetWriter } from './session-fleet-writer';
import { SessionHarnesses } from './session-harnesses';
import { SessionKiller } from './session-killer';
import { SessionRegistry } from './session-registry';
import { SessionSpawner } from './session-spawner';
import { SpawnRollback } from './spawn-rollback';
import { buildStubHarnessAdapter } from './testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from './testing/build-stub-memory-provider';

// The agents and execution targets a test runs its sessions under, and the
// runner of each spawn's steps; the spawner's own when absent.
interface SetupTestConfig {
  readonly adapters: readonly AgentAdapter[];
  readonly targets: readonly ExecutionTarget[];
  readonly runSteps?: SpawnStepRunner;
}

// The session modules wired as the session manager wires them, over a real
// state store that also holds each session's published record, with the
// test's agents and targets and a recorder for each callback.
async function setupTest(config: SetupTestConfig) {
  const tmp = setupTempDir('atc-session-spawner-');
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const records = new PublishedRecords({
    store,
    daemonID: store.daemonID,
    localDir: join(tmp.dir, 'records'),
    ghBin: 'gh',
    now: () => 0,
  });

  const stopMessageBridge = mock(() => Promise.resolve());

  const callbacks: SessionCallbacks = {
    onOutput: mock<() => void>(),
    onChange: mock<() => void>(),
    onBoot: mock<() => void>(),
    onRelay: mock<() => void>(),
    onEvent: mock<() => void>(),
    onProcessEnded: mock<() => void>(),

    // No agent here takes its messages through a bridge in the daemon.
    startMessageBridge: () => Promise.resolve(null),
    stopMessageBridge,
    log: mock<() => void>(),
    now: () => 0,
    getClock: () => systemClock,
    getAuthBinder: () => null,
    getRecords: () => records,
  };

  const registry = new SessionRegistry({
    fallback: null,
    adapters: config.adapters,
    targets: config.targets,
    targetErrors: [],
    callbacks,
  });

  const fleet = new SessionFleetWriter({
    registry,
    store,
    statusPath: join(tmp.dir, 'status.json'),
    callbacks,
  });

  const claims = new HostDirClaims({ registry });
  const killer = new SessionKiller({ registry, fleet, callbacks });
  const harnesses = new SessionHarnesses({ registry, fleet, killer, callbacks });
  const rollback = new SpawnRollback({ registry, fleet, claims, harnesses, callbacks });
  const auth = new AuthSetup({ registry, fleet, claims, harnesses, rollback, store, callbacks });

  const spawner = new SessionSpawner({
    registry,
    fleet,
    claims,
    harnesses,
    rollback,
    auth,
    callbacks,
    runSteps: config.runSteps ?? runSpawnSteps,
  });

  return {
    dir: tmp.dir,
    recordsDir: join(tmp.dir, 'records'),
    store,
    callbacks,
    stopMessageBridge,
    registry,
    claims,
    rollback,
    spawner,
  };
}

test('it lists a running session and starts its harness on the local target', async () => {
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const ctx = await setupTest({
    adapters: [buildStubHarnessAdapter()],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
  });

  const session = await ctx.spawner.spawn(ctx.dir, 'work', '', 120, 40);

  expect(ctx.registry.sessions).toMatchObject([{ name: 'work', cwd: ctx.dir, state: 'running' }]);
  expect(provider.harnesses).toHaveLength(1);

  expect(provider.harnesses[0]?.spec).toMatchObject({
    env: { ATC_SESSION_ID: session.id },
    cols: 120,
    rows: 40,
  });

  expect(ctx.callbacks.onEvent).toHaveBeenCalledExactlyOnceWith('added', session);
});

test('it rejects a spawn of an agent no adapter is registered for', async () => {
  const ctx = await setupTest({
    adapters: [buildStubHarnessAdapter()],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
    ],
  });

  const spawned = ctx.spawner.spawn(ctx.dir, 'work', '', 80, 24, false, 'auto', 'zai');

  expect(spawned).rejects.toThrowWithMessage(Error, "no adapter for agent 'zai'");
  expect(ctx.registry.sessions).toStrictEqual([]);
});

test('it rejects a spawn that trusts a cloned workspace without a workspace source', async () => {
  const ctx = await setupTest({
    adapters: [buildStubHarnessAdapter()],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
    ],
  });

  const spawned = ctx.spawner.spawn(ctx.dir, 'work', '', 80, 24, false, 'auto', 'claude', null, {
    trustClonedWorkspace: true,
  });

  expect(spawned).rejects.toMatchObject({ code: 'bad_args' });
  expect(ctx.registry.sessions).toStrictEqual([]);
});

test('it rejects a spawn whose harness its provider cannot start and lists nothing', async () => {
  const provider = buildStubMemoryProvider({
    kind: 'local-pty',
    onSpawn: () => {
      throw new Error('harness refused');
    },
  });

  const ctx = await setupTest({
    adapters: [buildStubHarnessAdapter()],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
  });

  const spawned = ctx.spawner.spawn(ctx.dir, 'work', '', 80, 24);

  expect(spawned).rejects.toThrowWithMessage(Error, 'harness refused');
  expect(ctx.registry.sessions).toStrictEqual([]);
});

test('it starts a spawn into the directory of an earlier spawn whose harness failed', async () => {
  const provider = buildStubMemoryProvider({
    kind: 'local-pty',
    onSpawn: mock<() => void>().mockImplementationOnce(() => {
      throw new Error('harness refused');
    }),
  });

  const ctx = await setupTest({
    adapters: [buildStubHarnessAdapter()],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
  });

  await ctx.spawner.spawn(ctx.dir, 'first', '', 80, 24).catch(() => null);

  const session = await ctx.spawner.spawn(ctx.dir, 'second', '', 80, 24);

  expect(ctx.registry.sessions).toStrictEqual([session]);
  expect(provider.harnesses).toHaveLength(1);
});

test('it gives a sub-session on a target without host lifecycle a host of its own', async () => {
  const ctx = await setupTest({
    adapters: [buildStubHarnessAdapter()],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
    ],
  });

  ctx.registry.sessions.push(
    buildMockSession({
      id: toSessionID('s-parent'),
      state: 'running',
      target: 'local',
      targetIdentity: 'local-pty:test',
      hostKey: toSessionID('s-parent'),
    }),
  );

  const session = await ctx.spawner.spawn(
    ctx.dir,
    'child',
    '',
    80,
    24,
    false,
    'auto',
    'claude',
    toSessionID('s-parent'),
    {},
    toSessionID('s-child'),
  );

  expect(session.hostKey).toBe(toSessionID('s-child'));
});

test("it runs a sub-session on its parent's host on a target with host lifecycle", async () => {
  const ctx = await setupTest({
    adapters: [buildStubHarnessAdapter()],
    targets: [
      buildMockExecutionTarget({
        id: 'imp',
        identity: 'imp:test',
        provider: buildStubMemoryProvider({
          kind: 'imp',
          capabilities: { suspend: true, destroy: true },
        }),
      }),
    ],
  });

  ctx.registry.sessions.push(
    buildMockSession({
      id: toSessionID('s-parent'),
      state: 'running',
      target: 'imp',
      targetIdentity: 'imp:test',
      hostKey: toSessionID('s-parent-host'),
    }),
  );

  const session = await ctx.spawner.spawn(
    ctx.dir,
    'child',
    '',
    80,
    24,
    false,
    'auto',
    'claude',
    toSessionID('s-parent'),
    {},
    toSessionID('s-child'),
    'imp',
  );

  expect(session.hostKey).toBe(toSessionID('s-parent-host'));
});

// Each row: the step that fails, the undos that run in order, how many
// times the workspace trust and the message bridge are taken back, whether
// the clone's directory is still there, and how many harnesses started.
test.each([
  ['claim', [], 0, 0, true, 0],
  ['workspace', ['claim'], 0, 0, true, 0],
  ['host', ['claim'], 0, 0, true, 0],
  ['trust', ['workspace', 'host', 'claim'], 0, 0, false, 0],
  ['record', ['trust', 'workspace', 'host', 'claim'], 1, 0, false, 0],
  ['reach', ['record', 'trust', 'workspace', 'host', 'claim'], 1, 0, false, 0],
  ['bridge', ['record', 'trust', 'workspace', 'host', 'claim'], 1, 0, false, 0],
  ['harness', ['bridge', 'record', 'trust', 'workspace', 'host', 'claim'], 1, 1, false, 0],
  ['list', ['harness', 'bridge', 'record', 'trust', 'workspace', 'host', 'claim'], 1, 1, false, 1],
  [
    'answer',
    ['harness', 'bridge', 'record', 'trust', 'workspace', 'host', 'claim'],
    1,
    1,
    false,
    1,
  ],
] as const)(
  'it undoes every step before a failed %s step, last step first, and leaves nothing running',
  async (failing, undone, trustRemovals, bridgeStops, cloneKept, started) => {
    const local = new LocalPTYProvider();

    // Harnesses run in memory; the workspace's directory commands run on
    // this machine, so the clone's directory resolves and is removed.
    const provider = buildStubMemoryProvider({
      kind: 'local-pty',
      runCommand: (spec) => local.runCommand(spec),
    });

    const removeTrust = mock(() => Promise.resolve());
    const ran: SpawnStepName[] = [];

    const ctx = await setupTest({
      adapters: [
        {
          ...buildStubHarnessAdapter(),
          updateLocalWorkspaceTrust: () => Promise.resolve(removeTrust),
        },
      ],
      targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],

      // Fails the first step of the scenario's name before it runs, and
      // records each undo as it runs.
      runSteps: (id, body) =>
        runSpawnSteps(id, (steps) =>
          body({
            run: (name, run, undo) =>
              name === failing
                ? Promise.reject(new Error(`the ${name} step refused`))
                : steps.run(name, run, async (result, failure) => {
                    if (undo !== undefined) {
                      ran.push(name);

                      await undo(result, failure);
                    }
                  }),
          }),
        ),
    });

    const id = toSessionID('s-steps');

    mkdirSync(join(ctx.dir, 'clone'));

    const spawned = ctx.spawner.spawn(
      join(ctx.dir, 'clone'),
      'clone',
      '',
      80,
      24,
      false,
      'auto',
      'claude',
      null,
      { trustClonedWorkspace: true },
      id,
      'local',
      async (host) => {
        await host.readyHost(1);

        return {
          workspace: {
            repoURL: 'https://example.test/harbor.git',
            sha: 'a1b2c3d',
            materializedAt: 0,
          },
          branch: 'main',
          withheldEnv: [],
        };
      },
      () => {},
      false,
      null,
      () => {},
    );

    await spawned.catch(() => null);

    const stored = await ctx.store.loadFleet();

    expect(spawned).rejects.toThrowWithMessage(Error, `the ${failing} step refused`);
    expect(ran).toStrictEqual([...undone]);
    expect(ctx.registry.sessions).toStrictEqual([]);
    expect(stored).toStrictEqual([]);
    expect(provider.harnesses).toHaveLength(started);
    expect(provider.harnesses.map((harness) => harness.readExit())).not.toContain(null);
    expect(removeTrust).toHaveBeenCalledTimes(trustRemovals);
    expect(ctx.stopMessageBridge).toHaveBeenCalledTimes(bridgeStops);
    expect(existsSync(join(ctx.dir, 'clone'))).toBe(cloneKept);
    expect(ctx.claims.reservations.has(id)).toBeFalse();
    expect(ctx.rollback.rollingBack.has(id)).toBeFalse();
    expect(existsSync(join(ctx.recordsDir, 's-steps.json'))).toBeFalse();
  },
);

test('it stops the unwind at an undo that fails and throws that the spawn may still stand', async () => {
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const ctx = await setupTest({
    adapters: [buildStubHarnessAdapter()],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
  });

  ctx.stopMessageBridge.mockImplementation(() => Promise.reject(new Error('bridge wedged')));

  const spawned = ctx.spawner.spawn(
    ctx.dir,
    'stuck',
    '',
    80,
    24,
    false,
    'auto',
    'claude',
    null,
    {},
    toSessionID('s-stuck'),
    'local',
    null,
    () => {},
    false,
    null,
    () => {
      throw new Error('the answer could not be built');
    },
  );

  await spawned.catch(() => null);

  expect(spawned).rejects.toThrowWithMessage(
    EffectRemainsError,
    'spawn of session s-stuck failed and taking back its bridge step failed too',
  );

  expect(ctx.registry.sessions).toStrictEqual([]);
});
