// oxlint-disable zgeoff/test-beside-module -- tests restore-fleet.ts; GEO-433 moves it beside its module
import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { ImpProvider } from '@atc/execution-imp/imp-provider';
import { createStubImpPort } from '@atc/execution-imp/testing/create-stub-imp-port';
import { buildTargetIdentity } from '@atc/store/build-target-identity';
import { StateStore } from '@atc/store/state-store';
import { buildMockFleetEntry } from '@atc/store/testing/build-mock-fleet-entry';
import { buildMockAgentAdapter } from '@atc/test-utils/build-mock-agent-adapter';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { restoreFleet } from './restore-fleet';
import { SessionManager } from './sessions';

async function setupTest() {
  const tmp = setupTempDir('atc-restore-imp-identity-');

  const store = await StateStore.open(join(tmp.dir, 'state.db'));

  onTestFinished(() => store.stop());

  const port = createStubImpPort();

  const provider = new ImpProvider(port, {}, { version: '1.0.0' });

  onTestFinished(() => {
    provider.dispose();
  });

  const options = { url: 'http://impd', image: 'new' };
  const identity = buildTargetIdentity('imp', options);

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    store,
    join(tmp.dir, 'status.json'),
    [],
    [{ id: 'cloud', kind: 'imp', options, identity, provider }],
  );

  onTestFinished(() => {
    mgr.detachAll();
  });

  return { dir: tmp.dir, store, port, provider, mgr, identity };
}

test('it restores and persists a live legacy cloud session after an image change', async () => {
  const ctx = await setupTest();

  const entry = buildMockFleetEntry({
    cwd: ctx.dir,
    target: 'cloud',
    targetIdentity: 'imp:0123456789abcdef',
  });

  await ctx.port.createImp({ name: ctx.provider.getImpName(entry.sessionID), image: 'old' });
  await ctx.store.writeFleet([entry]);

  const restored = await restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  await restored.settled;

  await ctx.mgr.writeFleet();

  expect(restored.restored).toBe(1);

  expect(ctx.mgr.sessions).toMatchObject([
    {
      id: entry.sessionID,
      targetIdentity: ctx.identity,
      state: 'running',
    },
  ]);

  expect(ctx.mgr.sessions[0]?.pty?.detach).toBeFunction();

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toMatchObject([{ sessionID: entry.sessionID, targetIdentity: ctx.identity }]);

  expect(ctx.port.createSpecs).toStrictEqual([
    { name: ctx.provider.getImpName(entry.sessionID), image: 'old' },
  ]);
});

test('it keeps a cloud session usable after the image changes under a versioned binding', async () => {
  const ctx = await setupTest();

  const entry = buildMockFleetEntry({
    cwd: ctx.dir,
    target: 'cloud',
    targetIdentity: buildTargetIdentity('imp', { url: 'http://impd', image: 'old' }),
  });

  await ctx.port.createImp({ name: ctx.provider.getImpName(entry.sessionID), image: 'old' });
  await ctx.store.writeFleet([entry]);

  const restored = await restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  await restored.settled;

  expect(ctx.mgr.sessions).toMatchObject([{ id: entry.sessionID, state: 'running' }]);
  expect(ctx.mgr.sessions[0]?.pty?.detach).toBeFunction();

  expect(
    ctx.mgr.findExecutionRefusal(
      { target: 'cloud', targetIdentity: entry.targetIdentity ?? null },
      'input',
    ),
  ).toBeNull();
});

test('it leaves a missing legacy imp refused instead of creating a replacement', async () => {
  const ctx = await setupTest();

  const entry = buildMockFleetEntry({
    cwd: ctx.dir,
    target: 'cloud',
    targetIdentity: 'imp:0123456789abcdef',
  });

  await ctx.store.writeFleet([entry]);

  const restored = await restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  await restored.settled;

  expect(ctx.mgr.sessions).toMatchObject([
    {
      id: entry.sessionID,
      targetIdentity: 'imp:0123456789abcdef',
      state: 'exited',
      pty: null,
      lastMsg: "target 'cloud' binding unverified",
    },
  ]);

  expect(ctx.port.createSpecs).toStrictEqual([]);
});

test('it restores a listed legacy session when its imp becomes reachable on a later restore', async () => {
  const ctx = await setupTest();

  const entry = buildMockFleetEntry({
    cwd: ctx.dir,
    target: 'cloud',
    targetIdentity: 'imp:0123456789abcdef',
  });

  await ctx.store.writeFleet([entry]);

  const first = await restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  await first.settled;

  const refused = ctx.mgr.sessions[0]?.lastMsg;

  await ctx.port.createImp({ name: ctx.provider.getImpName(entry.sessionID), image: 'old' });

  const restored = await restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  await restored.settled;

  expect(refused).toBe("target 'cloud' binding unverified");

  expect(ctx.mgr.sessions).toMatchObject([
    { id: entry.sessionID, targetIdentity: ctx.identity, state: 'running' },
  ]);

  expect(ctx.mgr.sessions).toBeArrayOfSize(1);
  expect(ctx.mgr.sessions[0]?.pty?.detach).toBeFunction();
});

test('it lists the adoption refusal in place of a stale binding refusal once the host check succeeds', async () => {
  const ctx = await setupTest();

  const entry = buildMockFleetEntry({
    cwd: ctx.dir,
    target: 'cloud',
    targetIdentity: 'imp:0123456789abcdef',
  });

  await ctx.store.writeFleet([entry]);

  const first = await restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  await first.settled;

  await ctx.port.createImp({ name: ctx.provider.getImpName(entry.sessionID) });

  ctx.port.setAcquireFailure(0, 'LEASED');

  const restored = await restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 0,
    retryDelaysMs: [],
  });

  await restored.settled;

  expect(ctx.mgr.sessions).toMatchObject([
    {
      id: entry.sessionID,
      targetIdentity: ctx.identity,
      state: 'exited',
      lastMsg: `imp ${ctx.provider.getImpName(entry.sessionID)} cannot be used: impd refused the lease (LEASED)`,
    },
  ]);
});
