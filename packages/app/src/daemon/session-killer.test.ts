import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { toSessionID } from '@atc/core/to-session-id';
import { buildTargetIdentity } from '@atc/store/build-target-identity';
import { StateStore } from '@atc/store/state-store';
import { createMigratedStateDB } from '@atc/store/testing/create-migrated-state-db';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { buildMockExecutionTarget } from '../test-utils/build-mock-execution-target';
import { buildMockSession } from '../test-utils/build-mock-session';
import type { ExecutionTarget } from './build-execution-targets';
import { SessionFleetWriter } from './session-fleet-writer';
import { SessionKiller } from './session-killer';
import { SessionRegistry } from './session-registry';
import { buildStubMemoryProvider } from './testing/build-stub-memory-provider';

interface SetupConfig {
  readonly targets: readonly ExecutionTarget[];
}

// A killer over a real registry of the targets the test gives and a real
// fleet writer on a migrated state store, with the daemon's callbacks as
// recorders. The daemon has no runtime auth binder, so a forget destroys
// a host through its provider.
async function setupTest(config: SetupConfig) {
  const tmp = setupTempDir('atc-session-killer-');
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const callbacks = {
    onEvent: mock(),
    onProcessEnded: mock(),
    onChange: mock(),
    log: mock(),
    getAuthBinder: () => null,
    getRecords: () => null,
  };

  const registry = new SessionRegistry({
    fallback: null,
    adapters: [],
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

  const killer = new SessionKiller({ registry, fleet, callbacks });

  return { store, registry, killer, callbacks };
}

test('it kills a live sub-session along with its parent', async () => {
  const local = buildStubMemoryProvider();

  const ctx = await setupTest({
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: local,
      }),
    ],
  });

  const parent = buildMockSession({
    id: toSessionID('s-parent'),
    name: 'wrangler',
    state: 'running',
    pty: local.spawnHarness({
      session: 's-parent',
      host: 's-parent',
      bin: 'claude',
      args: [],
      cwd: '/work/proj',
      env: {},
      cols: 80,
      rows: 24,
    }),
  });

  const child = buildMockSession({
    id: toSessionID('s-child'),
    name: 'worker',
    state: 'running',
    parent: toSessionID('s-parent'),
    pty: local.spawnHarness({
      session: 's-child',
      host: 's-child',
      bin: 'claude',
      args: [],
      cwd: '/work/proj',
      env: {},
      cols: 80,
      rows: 24,
    }),
  });

  ctx.registry.sessions.push(parent, child);

  await ctx.killer.kill(parent.id);

  expect(parent.state).toBe('exited');
  expect(child.state).toBe('exited');
});

test('it forgets a dead parent with its dead sub-sessions and promotes the live ones', async () => {
  const local = buildStubMemoryProvider();

  const ctx = await setupTest({
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: local,
      }),
    ],
  });

  const parent = buildMockSession({ id: toSessionID('s-c-parent'), name: 'wrangler', pty: null });

  const dead = buildMockSession({
    id: toSessionID('s-c-dead'),
    name: 'dead worker',
    parent: toSessionID('s-c-parent'),
    pty: null,
  });

  const live = buildMockSession({
    id: toSessionID('s-c-live'),
    name: 'live worker',
    state: 'running',
    parent: toSessionID('s-c-parent'),
    pty: local.spawnHarness({
      session: 's-c-live',
      host: 's-c-live',
      bin: 'claude',
      args: [],
      cwd: '/work/proj',
      env: {},
      cols: 80,
      rows: 24,
    }),
  });

  ctx.registry.sessions.push(parent, dead, live);

  await ctx.killer.kill(parent.id);

  expect(ctx.registry.sessions.map((s) => ({ id: s.id, parent: s.parent }))).toStrictEqual([
    { id: live.id, parent: null },
  ]);
});

test('it keeps an exited sub-session on a host-destroying target when a second kill forgets its dead local parent', async () => {
  const ctx = await setupTest({
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: buildStubMemoryProvider(),
      }),
      buildMockExecutionTarget({
        id: 'box',
        kind: 'imp-like',
        identity: 'imp-like:test',
        provider: buildStubMemoryProvider({
          capabilities: { suspend: true, destroy: true },
          remote: true,
        }),
      }),
    ],
  });

  const parent = buildMockSession({
    id: toSessionID('s-parent'),
    name: 'wrangler',
    target: 'local',
    pty: null,
  });

  const remote = buildMockSession({
    id: toSessionID('s-remote'),
    name: 'remote worker',
    parent: toSessionID('s-parent'),
    target: 'box',
    targetIdentity: 'imp-like:test',
    pty: null,
  });

  ctx.registry.sessions.push(parent, remote);

  await ctx.killer.kill(toSessionID('s-parent'));

  expect(ctx.registry.sessions.map((s) => ({ id: s.id, parent: s.parent }))).toStrictEqual([
    { id: remote.id, parent: null },
  ]);
});

test("it refuses to forget a session kept asleep inside its parent's host and keeps its record", async () => {
  const ctx = await setupTest({
    targets: [
      buildMockExecutionTarget({
        id: 'box',
        kind: 'imp-like',
        identity: 'imp-like:test',
        provider: buildStubMemoryProvider({
          capabilities: { suspend: true, destroy: true },
          remote: true,
        }),
      }),
    ],
  });

  ctx.registry.sessions.push(
    buildMockSession({
      id: toSessionID('s-parent'),
      name: 'wrangler',
      target: 'box',
      targetIdentity: 'imp-like:test',
      desired: 'sleep',
      vm: 'asleep',
      pty: null,
    }),
    buildMockSession({
      id: toSessionID('s-guest'),
      name: 'guest',
      parent: toSessionID('s-parent'),
      hostKey: toSessionID('s-parent'),
      target: 'box',
      targetIdentity: 'imp-like:test',
      desired: 'sleep',
      vm: 'asleep',
      pty: null,
    }),
  );

  const forgotten = ctx.killer.forget(toSessionID('s-guest'));

  expect(forgotten).rejects.toMatchObject({
    code: 'unsupported_operation',
    data: { problem: 'host_asleep', host: 's-parent' },
  });

  expect(ctx.registry.sessions.map((s) => s.id)).toStrictEqual([
    toSessionID('s-parent'),
    toSessionID('s-guest'),
  ]);
});

test("it forgets an exited session on its parent's host while that host is not asleep", async () => {
  const ctx = await setupTest({
    targets: [
      buildMockExecutionTarget({
        id: 'box',
        kind: 'imp-like',
        identity: 'imp-like:test',
        provider: buildStubMemoryProvider({
          capabilities: { suspend: true, destroy: true },
          remote: true,
        }),
      }),
    ],
  });

  ctx.registry.sessions.push(
    buildMockSession({
      id: toSessionID('s-parent'),
      name: 'wrangler',
      target: 'box',
      targetIdentity: 'imp-like:test',
      vm: 'unknown',
      pty: null,
    }),
    buildMockSession({
      id: toSessionID('s-guest'),
      name: 'guest',
      parent: toSessionID('s-parent'),
      hostKey: toSessionID('s-parent'),
      target: 'box',
      targetIdentity: 'imp-like:test',
      vm: 'unknown',
      pty: null,
    }),
  );

  const destroyed = await ctx.killer.forget(toSessionID('s-guest'));

  expect(destroyed).toBeFalse();
  expect(ctx.registry.sessions.map((s) => s.id)).toStrictEqual([toSessionID('s-parent')]);
});

test('it puts the host of a killed host owner to sleep and marks each session on it asleep', async () => {
  const box = buildStubMemoryProvider({
    capabilities: { suspend: true, destroy: true },
    remote: true,
  });

  const ctx = await setupTest({
    targets: [
      buildMockExecutionTarget({
        id: 'box',
        kind: 'imp-like',
        identity: 'imp-like:test',
        provider: box,
      }),
    ],
  });

  ctx.registry.sessions.push(
    buildMockSession({
      id: toSessionID('s-owner'),
      name: 'wrangler',
      state: 'running',
      target: 'box',
      targetIdentity: 'imp-like:test',
      vm: 'awake',
      attachment: 'attached',
      pty: box.spawnHarness({
        session: 's-owner',
        host: 's-owner',
        bin: 'claude',
        args: [],
        cwd: '/work/proj',
        env: {},
        cols: 80,
        rows: 24,
      }),
    }),
    buildMockSession({
      id: toSessionID('s-guest'),
      name: 'guest',
      state: 'running',
      parent: toSessionID('s-owner'),
      hostKey: toSessionID('s-owner'),
      target: 'box',
      targetIdentity: 'imp-like:test',
      vm: 'awake',
      attachment: 'attached',
      pty: box.spawnHarness({
        session: 's-guest',
        host: 's-owner',
        bin: 'claude',
        args: [],
        cwd: '/work/proj',
        env: {},
        cols: 80,
        rows: 24,
      }),
    }),
  );

  const outcome = await ctx.killer.kill(toSessionID('s-owner'));

  expect(outcome).toBe('stopped');
  expect(box.suspended).toStrictEqual(['s-owner']);

  expect(
    ctx.registry.sessions.map((s) => ({
      id: s.id,
      pty: s.pty,
      state: s.state,
      lastMsg: s.lastMsg,
      vm: s.vm,
      desired: s.desired,
      attachment: s.attachment,
      suspended: s.suspended,
    })),
  ).toStrictEqual([
    {
      id: toSessionID('s-owner'),
      pty: null,
      state: 'exited',
      lastMsg: 'asleep',
      vm: 'asleep',
      desired: 'sleep',
      attachment: 'detached',
      suspended: true,
    },
    {
      id: toSessionID('s-guest'),
      pty: null,
      state: 'exited',
      lastMsg: 'asleep',
      vm: 'asleep',
      desired: 'sleep',
      attachment: 'detached',
      suspended: true,
    },
  ]);
});

test('it refuses to kill a dead session on a target that destroys its host without confirmation', async () => {
  const ctx = await setupTest({
    targets: [
      buildMockExecutionTarget({
        id: 'box',
        kind: 'imp-like',
        identity: 'imp-like:test',
        provider: buildStubMemoryProvider({
          capabilities: { suspend: true, destroy: true },
          remote: true,
        }),
      }),
    ],
  });

  ctx.registry.sessions.push(
    buildMockSession({
      id: toSessionID('s-dead'),
      name: 'dead',
      target: 'box',
      targetIdentity: 'imp-like:test',
      pty: null,
    }),
  );

  const killed = ctx.killer.kill(toSessionID('s-dead'));

  expect(killed).rejects.toMatchObject({
    code: 'confirmation_required',
    data: { session: 's-dead' },
  });

  expect(ctx.registry.sessions.map((s) => s.id)).toStrictEqual([toSessionID('s-dead')]);
});

test('it destroys the host of a forgotten host owner and removes every session on that host', async () => {
  const box = buildStubMemoryProvider({
    capabilities: { suspend: true, destroy: true },
    remote: true,
  });

  const ctx = await setupTest({
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: buildStubMemoryProvider(),
      }),
      buildMockExecutionTarget({
        id: 'box',
        kind: 'imp-like',
        identity: 'imp-like:test',
        provider: box,
      }),
    ],
  });

  ctx.registry.sessions.push(
    buildMockSession({
      id: toSessionID('s-owner'),
      name: 'wrangler',
      target: 'box',
      targetIdentity: 'imp-like:test',
      pty: null,
    }),
    buildMockSession({
      id: toSessionID('s-guest'),
      name: 'guest',
      hostKey: toSessionID('s-owner'),
      target: 'box',
      targetIdentity: 'imp-like:test',
      pty: null,
    }),
    buildMockSession({ id: toSessionID('s-other'), name: 'bystander', target: 'local', pty: null }),
  );

  const destroyed = await ctx.killer.forget(toSessionID('s-owner'));

  expect(destroyed).toBeTrue();
  expect(box.destroyed).toStrictEqual(['s-owner']);
  expect(ctx.registry.sessions.map((s) => s.id)).toStrictEqual([toSessionID('s-other')]);
});

test('it leaves a dead session unchanged when the kill only stops', async () => {
  const ctx = await setupTest({
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: buildStubMemoryProvider(),
      }),
    ],
  });

  ctx.registry.sessions.push(
    buildMockSession({ id: toSessionID('s-dead'), name: 'dead', lastMsg: 'killed', pty: null }),
  );

  const outcome = await ctx.killer.kill(toSessionID('s-dead'), true);

  expect(outcome).toBe('unchanged');
  expect(ctx.registry.sessions.map((s) => s.id)).toStrictEqual([toSessionID('s-dead')]);
});
