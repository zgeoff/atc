import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { toSessionID } from '@atc/core';
import { EffectRemainsError } from '@atc/plugin-api';
import { createStateStore } from '@atc/store';
import {
  buildStubLog,
  createMigratedStateDB,
  registerTestCleanup,
  setupTempDir,
} from '@atc/test-utils';
import { createSessionFleetWriter } from '../fleet/create-session-fleet-writer';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildMockSession } from '../testing/build-mock-session';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { createHostDirClaims } from './create-host-dir-claims';
import { createSessionHarnesses } from './create-session-harnesses';
import { createSessionRegistry } from './create-session-registry';
import { createSpawnRollback } from './create-spawn-rollback';

// A rollback over the real session modules: a registry whose `local` target
// runs harnesses in memory, a fleet writer on a real state store, real
// directory claims and harness bookkeeping, and a recorder of logged lines.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-spawn-rollback-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const provider = buildStubMemoryProvider();
  const recorder = buildStubLog();

  const callbacks = {
    onEvent: mock<() => void>(),
    onChange: mock<() => void>(),
    onOutput: mock<() => void>(),
    onProcessEnded: mock<() => void>(),
    log: recorder.log,
    findRecords: () => null,
    findAuthBinder: () => null,
  };

  const registry = createSessionRegistry({
    fallback: null,
    adapters: [],
    targets: [buildMockExecutionTarget({ id: 'local', provider })],
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

  const harnesses = createSessionHarnesses({
    registry,
    fleet,
    killer: { updateSuspended: mock<() => void>() },
    callbacks,
  });

  const rollback = createSpawnRollback({ registry, fleet, claims, harnesses, callbacks });

  return { store, provider, registry, fleet, rollback, lines: recorder.lines };
}

test('it kills the running harness of a failed spawn and drops the session from the list and the stored fleet', async () => {
  const ctx = await setupTest();

  const session = buildMockSession({
    id: toSessionID('s-failed'),
    state: 'running',
    target: 'local',
  });

  session.pty = ctx.provider.spawnHarness({
    session: 's-failed',
    host: 's-failed',
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  ctx.registry.sessions.push(session);

  await ctx.fleet.writeFleet();

  await expect(ctx.rollback.removeListedSpawn(toSessionID('s-failed'), null)).toResolve();

  expect(ctx.provider.harnesses[0]?.readExit()).toStrictEqual({ exitCode: 0 });

  const stored = await ctx.store.loadFleet();

  expect(ctx.registry.sessions).toBeEmpty();
  expect(stored).toBeEmpty();
});

test('it leaves the list and the stored fleet as they are for a session it does not list', async () => {
  const ctx = await setupTest();

  const session = buildMockSession({
    id: toSessionID('s-listed'),
    state: 'running',
    target: 'local',
  });

  session.pty = ctx.provider.spawnHarness({
    session: 's-listed',
    host: 's-listed',
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  ctx.registry.sessions.push(session);

  await ctx.fleet.writeFleet();

  await expect(ctx.rollback.removeListedSpawn(toSessionID('s-unknown'), null)).toResolve();

  expect(ctx.provider.harnesses[0]?.readExit()).toBeNull();

  const stored = await ctx.store.loadFleet();

  expect(ctx.registry.sessions).toStrictEqual([session]);
  expect(stored).toMatchObject([{ sessionID: 's-listed' }]);
});

test('it rejects, keeps the session listed, and keeps the rollback unsettled when the killed harness never confirms its exit', async () => {
  const ctx = await setupTest();

  const session = buildMockSession({
    id: toSessionID('s-stuck'),
    state: 'running',
    target: 'local',
  });

  session.pty = {
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: () => {},
    resize: () => {},
    kill: mock<() => void>(),
    waitForExit: () => Promise.resolve(false),
    detach: () => {},
  };

  ctx.registry.sessions.push(session);

  ctx.rollback.failedSpawnExitWaitMs = 1;

  expect(ctx.rollback.removeListedSpawn(toSessionID('s-stuck'), null)).rejects.toThrowWithMessage(
    Error,
    'session s-stuck did not exit after its kill',
  );

  // The spawn's caller ends the rollback once its unwind stops, so the
  // settlement check then reads the recorded kill.
  ctx.rollback.rollingBack.delete(toSessionID('s-stuck'));

  const settled = await ctx.rollback.probeRollbackSettled(toSessionID('s-stuck'));

  expect(ctx.rollback.unconfirmedKills.has(toSessionID('s-stuck'))).toBeTrue();
  expect(ctx.registry.sessions).toStrictEqual([session]);
  expect(settled).toBeFalse();
});

test('it takes the whole host of a failed spawn that provisioned an auth attempt or owns a host it can destroy', async () => {
  const ctx = await setupTest();

  const destroyer = buildStubMemoryProvider({ capabilities: { destroy: true } });

  const withAttempt = ctx.rollback.shouldTakeHost(
    ctx.provider,
    toSessionID('s-own'),
    toSessionID('s-own'),
    'local',
    'attempt-7',
  );

  const ownHost = ctx.rollback.shouldTakeHost(
    destroyer,
    toSessionID('s-own'),
    toSessionID('s-own'),
    'local',
    null,
  );

  expect(withAttempt).toBeTrue();
  expect(ownHost).toBeTrue();
});

test("it keeps a parent's host, and an own host another session still uses, when a spawn fails", async () => {
  const ctx = await setupTest();

  const destroyer = buildStubMemoryProvider({ capabilities: { destroy: true } });

  ctx.registry.sessions.push(
    buildMockSession({
      id: toSessionID('s-neighbour'),
      hostKey: toSessionID('s-own'),
      target: 'local',
    }),
  );

  const parentHost = ctx.rollback.shouldTakeHost(
    destroyer,
    toSessionID('s-child'),
    toSessionID('s-parent'),
    'local',
    null,
  );

  const usedHost = ctx.rollback.shouldTakeHost(
    destroyer,
    toSessionID('s-own'),
    toSessionID('s-own'),
    'local',
    null,
  );

  expect(parentHost).toBeFalse();
  expect(usedHost).toBeFalse();
});

test('it destroys the own host of a failed spawn when the provider can destroy hosts', async () => {
  const ctx = await setupTest();

  const provider = buildStubMemoryProvider({ capabilities: { destroy: true } });

  await ctx.rollback.destroyFailedSpawnHost(
    provider,
    toSessionID('s-own'),
    toSessionID('s-own'),
    null,
  );

  expect(provider.destroyed).toStrictEqual(['s-own']);
});

test('it leaves the host of a parent alone when a sub-session spawn fails', async () => {
  const ctx = await setupTest();

  const provider = buildStubMemoryProvider({ capabilities: { destroy: true } });

  await ctx.rollback.destroyFailedSpawnHost(
    provider,
    toSessionID('s-child'),
    toSessionID('s-parent'),
    null,
  );

  expect(provider.destroyed).toBeEmpty();
});

test('it throws that the effect remains when destroying the failed spawn host rejects', async () => {
  const ctx = await setupTest();

  const provider = buildStubMemoryProvider({
    capabilities: { destroy: true },
    destroyHost: () => Promise.reject(new Error('host unreachable')),
  });

  expect(
    ctx.rollback.destroyFailedSpawnHost(provider, toSessionID('s-own'), toSessionID('s-own'), null),
  ).rejects.toThrowWithMessage(
    EffectRemainsError,
    'spawn of session s-own failed and destroying its host failed too',
  );
});

test('it logs and does not throw when taking back the local trust rejects', async () => {
  const ctx = await setupTest();

  await expect(
    ctx.rollback.removeLocalTrust(
      () => Promise.reject(new Error('config locked')),
      toSessionID('s-trust'),
    ),
  ).toResolve();

  expect(ctx.lines).toStrictEqual([
    'atc: the spawn of session s-trust failed to start and taking back its workspace trust failed too: config locked',
  ]);
});
