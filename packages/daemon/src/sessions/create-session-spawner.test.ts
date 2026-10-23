import { expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock, toSessionID } from '@atc/core';
import type { AgentAdapter } from '@atc/plugin-api';
import { EffectRemainsError } from '@atc/plugin-api';
import { createStateStore } from '@atc/store';
import {
  buildStubBrokeredGatewayAdapter,
  createMigratedStateDB,
  registerTestCleanup,
  setupTempDir,
} from '@atc/test-utils';
import { createAuthSetup } from '../auth/create-auth-setup';
import { createRuntimeAuthBinder } from '../auth/create-runtime-auth-binder';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import { createSessionFleetWriter } from '../fleet/create-session-fleet-writer';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildMockSession } from '../testing/build-mock-session';
import { buildStubCredentialBroker } from '../testing/build-stub-credential-broker';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { runLocalCommand } from '../testing/run-local-command';
import { createHostDirClaims } from './create-host-dir-claims';
import { createPublishedRecords } from './create-published-records';
import { createSessionHarnesses } from './create-session-harnesses';
import { createSessionKiller } from './create-session-killer';
import { createSessionRegistry } from './create-session-registry';
import { createSessionSpawner } from './create-session-spawner';
import { createSpawnRollback } from './create-spawn-rollback';
import { runSpawnSteps } from './run-spawn-steps';
import type { SpawnStepName, SpawnStepRunner } from './run-spawn-steps';
import type { SessionCallbacks } from './session-callbacks';

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
  const temporaryDirectory = setupTempDir('atc-session-spawner-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const records = createPublishedRecords({
    store,
    daemonID: store.daemonID,
    localDir: join(temporaryDirectory.path, 'records'),
    ghBin: 'gh',
    now: () => 0,
  });

  const authBinder = createRuntimeAuthBinder(store);
  const stopMessageBridge = mock(() => Promise.resolve());
  const onBoot = mock<() => void>();

  const callbacks: SessionCallbacks = {
    onOutput: mock<() => void>(),
    onChange: mock<() => void>(),
    onBoot,
    onRelay: mock<() => void>(),
    onEvent: mock<() => void>(),
    onProcessEnded: mock<() => void>(),

    // No agent here takes its messages through a bridge in the daemon.
    startMessageBridge: () => Promise.resolve(null),
    stopMessageBridge,
    log: mock<() => void>(),
    now: () => 0,
    getClock: () => systemClock,
    getReporterSocketPath: () => join(temporaryDirectory.path, 'reporter.sock'),
    findAuthBinder: () => authBinder,
    findRecords: () => records,
  };

  const registry = createSessionRegistry({
    fallback: null,
    adapters: config.adapters,
    targets: config.targets,
    targetErrors: [],
    callbacks,
  });

  const fleet = createSessionFleetWriter({
    registry,
    store,
    statusPath: join(temporaryDirectory.path, 'status.json'),
    callbacks,
  });

  const claims = createHostDirClaims({ registry });
  const restarts = { stopRestart: () => Promise.resolve(false) };
  const killer = createSessionKiller({ registry, fleet, callbacks, restarts });
  const harnesses = createSessionHarnesses({ registry, fleet, killer, callbacks });
  const rollback = createSpawnRollback({ registry, fleet, claims, harnesses, callbacks });
  const auth = createAuthSetup({ registry, fleet, claims, harnesses, rollback, store, callbacks });

  const spawner = createSessionSpawner({
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
    directory: temporaryDirectory.path,
    recordsDir: join(temporaryDirectory.path, 'records'),
    store,
    callbacks,
    stopMessageBridge,
    onBoot,
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

  const session = await ctx.spawner.spawn({
    cwd: ctx.directory,
    name: 'work',
    prompt: '',
    cols: 120,
    rows: 40,
  });

  expect(ctx.registry.sessions).toMatchObject([
    { name: 'work', cwd: ctx.directory, state: 'running' },
  ]);

  expect(provider.harnesses).toHaveLength(1);

  expect(provider.harnesses[0]?.spec).toMatchObject({
    env: { ATC_SESSION_ID: session.id },
    cols: 120,
    rows: 40,
  });

  expect(ctx.callbacks.onEvent).toHaveBeenCalledExactlyOnceWith('added', session);
});

test('it points the hooks of a session it starts at the reporter socket the daemon listens on', async () => {
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const ctx = await setupTest({
    adapters: [buildStubHarnessAdapter()],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
  });

  await ctx.spawner.spawn({ cwd: ctx.directory, name: 'work', prompt: '', cols: 120, rows: 40 });

  expect(provider.harnesses[0]?.spec.env['ATC_SOCKET']).toBe(join(ctx.directory, 'reporter.sock'));
});

test('it boots a session before output its harness writes at once can reach it', async () => {
  const booted: number[] = [];

  const ctx = await setupTest({
    adapters: [buildStubHarnessAdapter()],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',

        // A harness's first read can land in the microtask after its start,
        // so this records how many boots had run by then.
        provider: buildStubMemoryProvider({
          kind: 'local-pty',
          onSpawn: () => {
            queueMicrotask(() => {
              booted.push(ctx.onBoot.mock.calls.length);
            });
          },
        }),
      }),
    ],
  });

  await ctx.spawner.spawn({ cwd: ctx.directory, name: 'work', prompt: '', cols: 80, rows: 24 });

  expect(booted).toStrictEqual([1]);
});

test('it kills the harness and unlists the session when booting it throws', async () => {
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const ctx = await setupTest({
    adapters: [buildStubHarnessAdapter()],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
  });

  ctx.onBoot.mockImplementation(() => {
    throw new Error('the screen could not be built');
  });

  const spawned = ctx.spawner.spawn({
    cwd: ctx.directory,
    name: 'work',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  await spawned.catch(() => null);

  const stored = await ctx.store.loadFleet();

  expect(spawned).rejects.toThrowWithMessage(Error, 'the screen could not be built');
  expect(provider.harnesses[0]?.readExit()).toStrictEqual({ exitCode: 0 });
  expect(ctx.registry.sessions).toStrictEqual([]);
  expect(stored).toStrictEqual([]);
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

  const spawned = ctx.spawner.spawn({
    cwd: ctx.directory,
    name: 'work',
    prompt: '',
    cols: 80,
    rows: 24,
    agent: 'zai',
  });

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

  const spawned = ctx.spawner.spawn({
    cwd: ctx.directory,
    name: 'work',
    prompt: '',
    cols: 80,
    rows: 24,
    overrides: {
      trustClonedWorkspace: true,
    },
  });

  expect(spawned).rejects.toMatchObject({ code: 'bad_args' });
  expect(ctx.registry.sessions).toStrictEqual([]);
});

test('it takes clone trust for a brokered agent on a remote target that can trust a clone', async () => {
  const provider = buildStubMemoryProvider({
    kind: 'cloud',
    remote: true,
    brokerAuth: buildStubCredentialBroker(),
    guestWorkspaceTrust: true,
  });

  const ctx = await setupTest({
    adapters: [{ ...buildStubBrokeredGatewayAdapter(), planGuestWorkspaceTrust: () => ({}) }],
    targets: [
      buildMockExecutionTarget({ id: 'far', kind: 'cloud', identity: 'cloud:test', provider }),
    ],

    // the spawn reaches its steps only once it took the trust
    runSteps: () => Promise.reject(new Error('the spawn steps started')),
  });

  const spawned = ctx.spawner.spawn({
    cwd: ctx.directory,
    name: 'clone',
    prompt: '',
    cols: 80,
    rows: 24,
    agent: 'glm',
    overrides: { trustClonedWorkspace: true },
    id: toSessionID('s-trust'),
    target: 'far',
    materialize: () => Promise.resolve(null),
  });

  expect(spawned).rejects.toThrowWithMessage(Error, 'the spawn steps started');
});

test.each([
  ['false', { guestWorkspaceTrust: false }],
  ['absent', {}],
])(
  'it refuses clone trust for a brokered agent on a remote target whose trust flag is %s',
  async (_label, flags) => {
    const provider = buildStubMemoryProvider({
      kind: 'cloud',
      remote: true,
      brokerAuth: buildStubCredentialBroker(),
      ...flags,
    });

    const ctx = await setupTest({
      adapters: [{ ...buildStubBrokeredGatewayAdapter(), planGuestWorkspaceTrust: () => ({}) }],
      targets: [
        buildMockExecutionTarget({ id: 'far', kind: 'cloud', identity: 'cloud:test', provider }),
      ],
      runSteps: () => Promise.reject(new Error('the spawn steps started')),
    });

    const spawned = ctx.spawner.spawn({
      cwd: ctx.directory,
      name: 'clone',
      prompt: '',
      cols: 80,
      rows: 24,
      agent: 'glm',
      overrides: { trustClonedWorkspace: true },
      id: toSessionID('s-trust'),
      target: 'far',
      materialize: () => Promise.resolve(null),
    });

    expect(spawned).rejects.toMatchObject({ code: 'unsupported' });
  },
);

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

  const spawned = ctx.spawner.spawn({
    cwd: ctx.directory,
    name: 'work',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  expect(spawned).rejects.toThrowWithMessage(Error, 'harness refused');
  expect(ctx.registry.sessions).toStrictEqual([]);
});

test('it drops the stored record of a spawn whose record copy fails to land', async () => {
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const ctx = await setupTest({
    adapters: [buildStubHarnessAdapter()],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
  });

  // A file where the copies' folder belongs fails the copy after the
  // record is stored.
  writeFileSync(ctx.recordsDir, 'in the way');

  const spawned = ctx.spawner.spawn({
    cwd: ctx.directory,
    name: 'work',
    prompt: '',
    cols: 80,
    rows: 24,
    id: toSessionID('s-copy'),
  });

  await spawned.catch(() => null);

  const stored = await ctx.store.readPublishedRecord(toSessionID('s-copy'));

  expect(spawned).rejects.toThrow();
  expect(stored).toBeNull();
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

  await ctx.spawner
    .spawn({ cwd: ctx.directory, name: 'first', prompt: '', cols: 80, rows: 24 })
    .catch(() => null);

  const session = await ctx.spawner.spawn({
    cwd: ctx.directory,
    name: 'second',
    prompt: '',
    cols: 80,
    rows: 24,
  });

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

  const session = await ctx.spawner.spawn({
    cwd: ctx.directory,
    name: 'child',
    prompt: '',
    cols: 80,
    rows: 24,
    parent: toSessionID('s-parent'),
    id: toSessionID('s-child'),
  });

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

  const session = await ctx.spawner.spawn({
    cwd: ctx.directory,
    name: 'child',
    prompt: '',
    cols: 80,
    rows: 24,
    parent: toSessionID('s-parent'),
    id: toSessionID('s-child'),
    target: 'imp',
  });

  expect(session.hostKey).toBe(toSessionID('s-parent-host'));
});

test.each([
  {
    failing: 'claim',
    undone: [],
    trustRemovals: 0,
    bridgeStops: 0,
    cloneKept: true,
    started: 0,
  },
  {
    failing: 'workspace',
    undone: ['claim'],
    trustRemovals: 0,
    bridgeStops: 0,
    cloneKept: true,
    started: 0,
  },
  {
    failing: 'host',
    undone: ['claim'],
    trustRemovals: 0,
    bridgeStops: 0,
    cloneKept: true,
    started: 0,
  },
  {
    failing: 'trust',
    undone: ['workspace', 'host', 'claim'],
    trustRemovals: 0,
    bridgeStops: 0,
    cloneKept: false,
    started: 0,
  },
  {
    failing: 'record',
    undone: ['trust', 'workspace', 'host', 'claim'],
    trustRemovals: 1,
    bridgeStops: 0,
    cloneKept: false,
    started: 0,
  },
  {
    failing: 'reach',
    undone: ['record', 'trust', 'workspace', 'host', 'claim'],
    trustRemovals: 1,
    bridgeStops: 0,
    cloneKept: false,
    started: 0,
  },
  {
    failing: 'bridge',
    undone: ['record', 'trust', 'workspace', 'host', 'claim'],
    trustRemovals: 1,
    bridgeStops: 0,
    cloneKept: false,
    started: 0,
  },
  {
    failing: 'harness',
    undone: ['bridge', 'record', 'trust', 'workspace', 'host', 'claim'],
    trustRemovals: 1,
    bridgeStops: 1,
    cloneKept: false,
    started: 0,
  },
  {
    failing: 'list',
    undone: ['harness', 'bridge', 'record', 'trust', 'workspace', 'host', 'claim'],
    trustRemovals: 1,
    bridgeStops: 1,
    cloneKept: false,
    started: 1,
  },
  {
    failing: 'harness-start',
    undone: ['harness', 'bridge', 'record', 'trust', 'workspace', 'host', 'claim'],
    trustRemovals: 1,
    bridgeStops: 1,
    cloneKept: false,
    started: 1,
  },
  {
    failing: 'answer',
    undone: ['harness', 'bridge', 'record', 'trust', 'workspace', 'host', 'claim'],
    trustRemovals: 1,
    bridgeStops: 1,
    cloneKept: false,
    started: 1,
  },
] as const)(
  'it undoes every step before a failed $failing step, last step first, and leaves nothing running',
  async (scenario) => {
    // Harnesses run in memory; the workspace's directory commands run on
    // this machine, so the clone's directory resolves and is removed.
    const provider = buildStubMemoryProvider({ kind: 'local-pty', runCommand: runLocalCommand });
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
              name === scenario.failing
                ? Promise.reject(new Error(`the ${name} step refused`))
                : steps.run(name, run, async (result, failure) => {
                    if (undo !== undefined) {
                      ran.push(name);

                      await undo(result, failure);
                    }
                  }),
            runNow: (name, run, undo) =>
              steps.runNow(
                name,
                () => {
                  if (name === scenario.failing) {
                    throw new Error(`the ${name} step refused`);
                  }

                  return run();
                },
                async (result, failure) => {
                  if (undo !== undefined) {
                    ran.push(name);

                    await undo(result, failure);
                  }
                },
              ),
          }),
        ),
    });

    const id = toSessionID('s-steps');

    mkdirSync(join(ctx.directory, 'clone'));

    const spawned = ctx.spawner.spawn({
      cwd: join(ctx.directory, 'clone'),
      name: 'clone',
      prompt: '',
      cols: 80,
      rows: 24,
      overrides: { trustClonedWorkspace: true },
      id,
      target: 'local',
      materialize: async (host) => {
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
      answer: () => {},
    });

    await spawned.catch(() => null);

    const stored = await ctx.store.loadFleet();

    expect(spawned).rejects.toThrowWithMessage(Error, `the ${scenario.failing} step refused`);
    expect(ran).toStrictEqual([...scenario.undone]);
    expect(ctx.registry.sessions).toStrictEqual([]);
    expect(stored).toStrictEqual([]);
    expect(provider.harnesses).toHaveLength(scenario.started);
    expect(provider.harnesses.map((harness) => harness.readExit())).not.toContain(null);
    expect(removeTrust).toHaveBeenCalledTimes(scenario.trustRemovals);
    expect(ctx.stopMessageBridge).toHaveBeenCalledTimes(scenario.bridgeStops);
    expect(existsSync(join(ctx.directory, 'clone'))).toBe(scenario.cloneKept);
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

  const spawned = ctx.spawner.spawn({
    cwd: ctx.directory,
    name: 'stuck',
    prompt: '',
    cols: 80,
    rows: 24,
    id: toSessionID('s-stuck'),
    answer: () => {
      throw new Error('the answer could not be built');
    },
  });

  await spawned.catch(() => null);

  expect(spawned).rejects.toThrowWithMessage(
    EffectRemainsError,
    'spawn of session s-stuck failed and taking back its bridge step failed too',
  );

  expect(ctx.registry.sessions).toStrictEqual([]);
});
