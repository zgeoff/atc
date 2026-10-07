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
import { waitFor } from '../test-utils/wait-for';
import { ImpProvider } from './imp-provider';
import { restoreFleet } from './restore-fleet';
import { SessionManager } from './sessions';

interface RestoreTestConfig {
  readonly adapter: AgentAdapter;
}

// A session manager running the given agent, whose one target `box` runs
// on the imp provider over a fixture imp port, with every line it logs
// collected.
async function setupTest(config: RestoreTestConfig) {
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

  const mgr = new SessionManager(
    config.adapter,
    store,
    join(tmp.dir, 'status.json'),
    [],
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider }],
  );

  mgr.log = (line) => {
    logged.push(line);
  };

  stack.defer(() => {
    mgr.detachAll();
  });

  const owned = stack.move();

  return {
    dir: tmp.dir,
    store,
    mgr,
    logged,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it restores the fleet with no terminal for each session whose agent is not signed in on its imp', async () => {
  await using ctx = await setupTest({
    adapter: buildMockAgentAdapter({ planAuthCheck: () => ['false'] }),
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
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 50,
  });

  expect(restored.restored).toBe(2);

  expect<readonly unknown[]>(ctx.mgr.sessions.map((s) => [s.id, s.pty !== null])).toStrictEqual([
    ['s-first', false],
    ['s-second', false],
  ]);
});

test('it logs a later session whose revive fails and leaves it without a terminal', async () => {
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

  await using ctx = await setupTest({ adapter: buildMockAgentAdapter({ planGuestSpawn }) });

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
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 50,
  });

  expect(restored.restored).toBe(2);

  await waitFor(() => {
    expect<readonly unknown[]>(ctx.logged).toStrictEqual([
      'atc could not revive session s-second (no plan for s-second)',
    ]);
  });

  expect<readonly unknown[]>(ctx.mgr.sessions.map((s) => [s.id, s.pty !== null])).toStrictEqual([
    ['s-first', true],
    ['s-second', false],
  ]);
});

test('it logs a first session whose revive fails with a plain error and still revives the next one', async () => {
  const planGuestSpawn = mock<NonNullable<AgentAdapter['planGuestSpawn']>>(() => ({
    bin: 'sleep',
    args: ['30'],
    files: {},
  }));

  planGuestSpawn.mockImplementationOnce(() => {
    throw new Error('no plan for s-first');
  });

  await using ctx = await setupTest({ adapter: buildMockAgentAdapter({ planGuestSpawn }) });

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
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: () => {},
    cols: 80,
    rows: 24,
    capMs: 50,
  });

  expect(restored.restored).toBe(2);

  await waitFor(() => {
    expect<readonly unknown[]>(ctx.mgr.sessions.map((s) => [s.id, s.pty !== null])).toStrictEqual([
      ['s-first', false],
      ['s-second', true],
    ]);
  });

  expect<readonly unknown[]>(ctx.logged).toStrictEqual([
    'atc could not revive session s-first (no plan for s-first)',
  ]);
});
