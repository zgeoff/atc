import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { systemClock } from '@atc/core/system-clock';
import { toSessionID } from '@atc/core/to-session-id';
import type { AgentAdapter } from '@atc/plugin-api/agent-adapter';
import { StateStore } from '@atc/store/state-store';
import { createMigratedStateDB } from '@atc/store/testing/create-migrated-state-db';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { buildMockExecutionTarget } from '../test-utils/build-mock-execution-target';
import { buildMockSession } from '../test-utils/build-mock-session';
import { AuthSetup } from './auth-setup';
import type { ExecutionTarget } from './build-execution-targets';
import { HostDirClaims } from './host-dir-claims';
import type { SessionCallbacks } from './session-callbacks';
import { SessionFleetWriter } from './session-fleet-writer';
import { SessionHarnesses } from './session-harnesses';
import { SessionKiller } from './session-killer';
import { SessionRegistry } from './session-registry';
import { SessionSpawner } from './session-spawner';
import { SpawnRollback } from './spawn-rollback';
import { buildStubHarnessAdapter } from './testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from './testing/build-stub-memory-provider';

// The agents and execution targets a test runs its sessions under.
interface SetupTestConfig {
  readonly adapters: readonly AgentAdapter[];
  readonly targets: readonly ExecutionTarget[];
}

// The session modules wired as the session manager wires them, over a real
// state store, with the test's agents and targets and a recorder for each
// callback.
async function setupTest(config: SetupTestConfig) {
  const tmp = setupTempDir('atc-session-spawner-');
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const callbacks: SessionCallbacks = {
    onOutput: mock(),
    onChange: mock(),
    onBoot: mock(),
    onRelay: mock(),
    onEvent: mock(),
    onProcessEnded: mock(),
    log: mock(),
    now: () => 0,
    getClock: () => systemClock,
    getAuthBinder: () => null,
    getRecords: () => null,
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
  });

  return { dir: tmp.dir, callbacks, registry, spawner };
}

test('it lists a running session and starts its harness on the local target', async () => {
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const ctx = await setupTest({
    adapters: [buildStubHarnessAdapter()],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
  });

  const session = await ctx.spawner.spawn(ctx.dir, 'work', '', 120, 40);

  expect(ctx.registry.sessions).toStrictEqual([
    expect.objectContaining({ name: 'work', cwd: ctx.dir, state: 'running' }),
  ]);

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
    onSpawn: mock().mockImplementationOnce(() => {
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
