import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { toSessionID } from '@atc/core';
import { EffectRemainsError } from '@atc/plugin-api';
import { StateStore } from '@atc/store';
import { createMigratedStateDB } from '@atc/store/testing';
import { buildStubLog, registerTestCleanup, setupTempDir, waitFor } from '@atc/test-utils';
import { buildMockExecutionTarget } from '../test-utils/build-mock-execution-target';
import { buildMockSession } from '../test-utils/build-mock-session';
import { HostDirClaims } from './host-dir-claims';
import { SessionFleetWriter } from './session-fleet-writer';
import { SessionHarnesses } from './session-harnesses';
import { SessionRegistry } from './session-registry';
import { SpawnRollback } from './spawn-rollback';
import { buildStubMemoryProvider } from './testing/build-stub-memory-provider';

// A rollback over the real session modules: a registry whose `local` target
// runs harnesses in memory, a fleet writer on a real state store, real
// directory claims and harness bookkeeping, and a recorder of logged lines.
async function setupTest() {
  const tmp = setupTempDir('atc-spawn-rollback-');
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const provider = buildStubMemoryProvider();
  const recorder = buildStubLog();

  const callbacks = {
    onEvent: mock<() => void>(),
    onChange: mock<() => void>(),
    onOutput: mock<() => void>(),
    onProcessEnded: mock<() => void>(),
    log: recorder.log,
    getRecords: () => null,
    getAuthBinder: () => null,
  };

  const registry = new SessionRegistry({
    fallback: null,
    adapters: [],
    targets: [buildMockExecutionTarget({ id: 'local', provider })],
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

  const harnesses = new SessionHarnesses({
    registry,
    fleet,
    killer: { updateSuspended: mock<() => void>() },
    callbacks,
  });

  const rollback = new SpawnRollback({ registry, fleet, claims, harnesses, callbacks });

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

  await expect(ctx.rollback.removeFailedSpawn(toSessionID('s-failed'))).toResolve();

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

  await expect(ctx.rollback.removeFailedSpawn(toSessionID('s-unknown'))).toResolve();

  expect(ctx.provider.harnesses[0]?.readExit()).toBeNull();

  const stored = await ctx.store.loadFleet();

  expect(ctx.registry.sessions).toStrictEqual([session]);
  expect(stored).toMatchObject([{ sessionID: 's-listed' }]);
});

test('it rejects and keeps the rollback unsettled when the killed harness never confirms its exit', async () => {
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

  expect(ctx.rollback.removeFailedSpawn(toSessionID('s-stuck'))).rejects.toThrowWithMessage(
    Error,
    'session s-stuck did not exit after its kill',
  );

  // The settlement check runs once the rollback has ended, so it reads the
  // recorded kill rather than the rollback still running.
  await waitFor(() => {
    expect(ctx.rollback.rollingBack.has(toSessionID('s-stuck'))).toBeFalse();
  });

  const settled = await ctx.rollback.isRollbackSettled(toSessionID('s-stuck'));

  expect(ctx.rollback.unconfirmedKills.has(toSessionID('s-stuck'))).toBeTrue();
  expect(settled).toBeFalse();
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
