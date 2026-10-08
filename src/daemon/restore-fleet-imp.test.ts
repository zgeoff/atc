import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import type { AgentAdapter } from '../agents/agent-adapter';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { buildStubLog } from '../test-utils/build-stub-log';
import { createMigratedStateDB } from '../test-utils/create-migrated-state-db';
import { createStubImpPort } from '../test-utils/create-stub-imp-port';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { ImpProvider } from './imp-provider';
import { restoreFleet } from './restore-fleet';
import { SessionManager } from './sessions';

// The fixed parts every restore test shares: a real state store, a recorder
// of logged lines, and an imp provider over a stub imp port. A manager the
// test holds after this setup detaches before the store and the provider go.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-restore-imp-'));
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  stack.defer(() => store.stop());

  const port = stack.use(createStubImpPort());

  const provider = new ImpProvider(port, { guestDir: join(tmp.dir, 'g') });

  stack.defer(() => {
    provider.dispose();
  });

  const recorder = buildStubLog();
  const owned = stack.move();

  return {
    dir: tmp.dir,
    statusPath: join(tmp.dir, 'status.json'),
    store,
    provider,
    logged: recorder.lines,
    log: recorder.log,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it restores the fleet with no terminal for each session whose agent is not signed in on its imp', async () => {
  await using ctx = await setupTest();

  using mgr = new SessionManager(
    buildMockAgentAdapter({ planAuthCheck: () => ['false'] }),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider }],
  );

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
  await using ctx = await setupTest();

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

  using mgr = new SessionManager(
    buildMockAgentAdapter({ planGuestSpawn }),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider }],
  );

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
    'atc could not revive session s-second (no plan for s-second)',
  ]);

  expect<readonly unknown[]>(mgr.sessions.map((s) => [s.id, s.pty !== null])).toStrictEqual([
    ['s-first', true],
    ['s-second', false],
  ]);
});

test('it logs a first session whose revive fails with a plain error and still revives the next one', async () => {
  await using ctx = await setupTest();

  const planGuestSpawn = mock<NonNullable<AgentAdapter['planGuestSpawn']>>(() => ({
    bin: 'sleep',
    args: ['30'],
    files: {},
  }));

  planGuestSpawn.mockImplementationOnce(() => {
    throw new Error('no plan for s-first');
  });

  using mgr = new SessionManager(
    buildMockAgentAdapter({ planGuestSpawn }),
    ctx.store,
    ctx.statusPath,
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider }],
  );

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
  ]);
});
