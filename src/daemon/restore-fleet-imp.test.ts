import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import type { AgentAdapter } from '../agents/agent-adapter';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { createMigratedStateDB } from '../test-utils/create-migrated-state-db';
import { FixtureImpPort } from '../test-utils/fixture-imp-port';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { ImpProvider } from './imp-provider';
import { restoreFleet } from './restore-fleet';
import { SessionManager } from './sessions';

// The fixed parts every restore test shares: a real state store, a recorder
// of logged lines, and one target `box` on the imp provider over a fixture
// imp port. `defer` runs a teardown before the store and the provider go,
// so a manager the test builds detaches first.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-restore-imp-'));
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  stack.defer(() => store.stop());

  const port = stack.use(new FixtureImpPort());

  const provider = new ImpProvider(port, { guestDir: join(tmp.dir, 'g') });

  stack.defer(() => {
    provider.dispose();
  });

  const logged: string[] = [];
  const owned = stack.move();

  return {
    dir: tmp.dir,
    statusPath: join(tmp.dir, 'status.json'),
    store,
    targets: [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider }],
    logged,
    log: (line: string) => {
      logged.push(line);
    },
    defer: (teardown: () => void) => {
      owned.defer(teardown);
    },
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it restores the fleet with no terminal for each session whose agent is not signed in on its imp', async () => {
  await using ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter({ planAuthCheck: () => ['false'] }),
    ctx.store,
    ctx.statusPath,
    [],
    ctx.targets,
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

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

  const mgr = new SessionManager(
    buildMockAgentAdapter({ planGuestSpawn }),
    ctx.store,
    ctx.statusPath,
    [],
    ctx.targets,
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

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

  const mgr = new SessionManager(
    buildMockAgentAdapter({ planGuestSpawn }),
    ctx.store,
    ctx.statusPath,
    [],
    ctx.targets,
  );

  mgr.log = ctx.log;

  ctx.defer(() => {
    mgr.detachAll();
  });

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
