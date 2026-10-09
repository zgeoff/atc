import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { createStubImpPort } from '../test-utils/create-stub-imp-port';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { buildTargetIdentity } from './build-target-identity';
import { ImpProvider } from './imp-provider';
import { restoreFleet } from './restore-fleet';
import { SessionManager } from './sessions';

async function setupTest() {
  const tmp = setupTempDir('atc-restore-imp-identity-');

  const store = await StateStore.open(join(tmp.dir, 'state.db'));

  onTestFinished(() => store.stop());

  const port = createStubImpPort();

  const provider = new ImpProvider(port, {});

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
      lastMsg: "target 'cloud' changed",
    },
  ]);

  expect(ctx.port.createSpecs).toStrictEqual([]);
});
