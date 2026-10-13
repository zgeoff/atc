// oxlint-disable zgeoff/test-beside-module -- tests restore-fleet.ts; GEO-433 moves it beside its module
import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { toSessionID } from '@atc/core/to-session-id';
import { ImpProvider } from '@atc/execution-imp/imp-provider';
import { createStubImpPort } from '@atc/execution-imp/testing/create-stub-imp-port';
import type { AgentAdapter } from '@atc/plugin-api/agent-adapter';
import { StateStore } from '@atc/store/state-store';
import { buildMockFleetEntry } from '@atc/store/testing/build-mock-fleet-entry';
import { createMigratedStateDB } from '@atc/store/testing/create-migrated-state-db';
import { buildMockAgentAdapter } from '@atc/test-utils/build-mock-agent-adapter';
import { buildStubClock } from '@atc/test-utils/build-stub-clock';
import { buildStubLog } from '@atc/test-utils/build-stub-log';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { waitFor } from '@atc/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { restoreFleet } from './restore-fleet';
import { SessionManager } from './sessions';

// The fixed parts every restore test shares: a real state store, a recorder
// of logged lines, and an imp provider over a stub imp port. A manager the
// test holds after this setup detaches before the store and the provider go.
async function setupTest() {
  const tmp = setupTempDir('atc-restore-imp-');
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const port = createStubImpPort();

  const provider = new ImpProvider(port, { guestDir: join(tmp.dir, 'g') }, { version: '1.0.0' });

  registerTestCleanup(() => {
    provider.dispose();
  });

  const recorder = buildStubLog();

  return {
    dir: tmp.dir,
    statusPath: join(tmp.dir, 'status.json'),
    store,
    port,
    provider,
    logged: recorder.lines,
    log: recorder.log,
  };
}

test('it restores the fleet with no terminal for each session whose agent is not signed in on its imp', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter({ planAuthCheck: () => ['false'] }),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider }],
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
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider }],
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
    expect.stringMatching(/^atc: wake of session s-first on target 'box' took /),
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
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider }],
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
    expect.stringMatching(/^atc: wake of session s-second on target 'box' took /),
  ]);
});

test('it lists and logs the refusal of a session whose imp refuses it with no retry left', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider }],
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

  ctx.port.setAcquireFailure(0, 'UNAVAILABLE');

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

  const refusal = `imp ${ctx.provider.getImpName('s-busy')} cannot be used: impd refused the lease (UNAVAILABLE)`;

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
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider }],
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

  ctx.port.setAcquireFailure(0, 'UNAVAILABLE');

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
    `atc could not revive session s-busy (imp ${ctx.provider.getImpName('s-busy')} cannot be used: impd refused the lease (UNAVAILABLE)); trying again`,
    expect.stringMatching(/^atc: wake of session s-busy on target 'box' took /),
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
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider }],
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

  ctx.port.setAcquireFailure(0, 'UNAVAILABLE');

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

  ctx.port.startLeaseHold();
  clock.advance(5000);

  await waitFor(() => {
    expect(ctx.port.countHeldLeases()).toBe(1);
  });

  await mgr.kill(toSessionID('s-busy'), true);

  ctx.port.stopLeaseHold();

  await restored.settled;

  expect(mgr.sessions).toMatchObject([
    { id: 's-busy', state: 'exited', lastMsg: 'killed', pty: null },
  ]);

  expect(ctx.port.sessionRequests).toStrictEqual([]);
});

test('it leaves stopped a session a caller stops while a try its imp then refuses readies the imp', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider }],
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

  ctx.port.setAcquireFailure(0, 'UNAVAILABLE');
  ctx.port.startLeaseHold();

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
    expect(ctx.port.countHeldLeases()).toBe(1);
  });

  await mgr.kill(toSessionID('s-busy'), true);

  ctx.port.stopLeaseHold();

  const restored = await restoring;

  await restored.settled;

  expect(mgr.sessions).toMatchObject([
    { id: 's-busy', state: 'exited', lastMsg: 'killed', pty: null },
  ]);

  expect(ctx.port.sessionRequests).toStrictEqual([]);

  expect<readonly unknown[]>(ctx.logged).toStrictEqual([
    `atc could not revive session s-busy (imp ${ctx.provider.getImpName('s-busy')} cannot be used: impd refused the lease (UNAVAILABLE))`,
  ]);
});

test('it revives on a later restore a session an earlier restore left without a terminal', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider }],
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

  ctx.port.setAcquireFailure(0, 'UNAVAILABLE');

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
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider }],
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

  const requests = ctx.port.sessionRequests.length;

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

  expect(ctx.port.sessionRequests.length - requests).toBe(0);
  expect(mgr.sessions).toMatchObject([{ id: 's-headless', kind: 'headless', pty: null }]);
});
