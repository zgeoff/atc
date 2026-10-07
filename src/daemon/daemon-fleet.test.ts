import { expect, test } from 'bun:test';
import { getRecord } from '../shared/get-record';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { startTestDaemon } from '../test-utils/start-test-daemon';

interface SetupConfig {
  // Writes what the state store holds before the daemon boots, given the
  // store and the test's temp directory.
  readonly seed: (store: StateStore, dir: string) => Promise<void>;
}

/**
 * A real daemon booted on a state store the test seeded first, whose
 * sessions run a sleep with no agent CLI behind them.
 */
function setupTest(config: SetupConfig) {
  return startTestDaemon({
    prefix: 'atc-daemon-fleet-',
    options: async (paths) => {
      await using stack = new AsyncDisposableStack();

      const store = await StateStore.open(paths.dbPath);

      stack.defer(() => store.stop());

      await config.seed(store, paths.dir);

      return { adapter: buildMockAgentAdapter() };
    },
  });
}

test('it keeps every stored fleet row restorable when a spawn writes the fleet before the restore', async () => {
  await using ctx = await setupTest({
    seed: (store, dir) =>
      store.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-live-a'), name: 'live-a', cwd: dir }),
        buildMockFleetEntry({ sessionID: toSessionID('s-live-b'), name: 'live-b', cwd: dir }),
        buildMockFleetEntry({
          sessionID: toSessionID('s-exited-a'),
          name: 'exited-a',
          cwd: dir,
          exited: true,
        }),
        buildMockFleetEntry({
          sessionID: toSessionID('s-exited-b'),
          name: 'exited-b',
          cwd: dir,
          exited: true,
        }),
      ]),
  });

  await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'claude',
    name: 'fresh',
    cols: 80,
    rows: 24,
  });

  const restored = await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  const listed = await ctx.client.sendRequest('session.list');

  expect(restored).toStrictEqual({ restored: 4 });

  expect(listed['sessions']).toIncludeAllPartialMembers([
    { id: 's-live-a', name: 'live-a', alive: true },
    { id: 's-live-b', name: 'live-b', alive: true },
    { id: 's-exited-a', name: 'exited-a', alive: false },
    { id: 's-exited-b', name: 'exited-b', alive: false },
    { name: 'fresh', alive: true },
  ]);
});

test('it keeps every stored fleet row when a rename and a deliberate kill write the fleet before the restore', async () => {
  await using ctx = await setupTest({
    seed: (store, dir) =>
      store.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-live-a'), name: 'live-a', cwd: dir }),
        buildMockFleetEntry({
          sessionID: toSessionID('s-exited-a'),
          name: 'exited-a',
          cwd: dir,
          exited: true,
        }),
      ]),
  });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'claude',
    name: 'fresh',
    cols: 80,
    rows: 24,
  });

  const sessionID = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.update', { session: sessionID, name: 'renamed' });
  await ctx.client.sendRequest('session.kill', { session: sessionID });
  await ctx.client.sendRequest('session.kill', { session: sessionID });

  const restored = await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  const listed = await ctx.client.sendRequest('session.list');

  expect(restored).toStrictEqual({ restored: 2 });

  expect(listed['sessions']).toIncludeSameMembers([
    expect.objectContaining({ id: 's-live-a', name: 'live-a', alive: true }),
    expect.objectContaining({ id: 's-exited-a', name: 'exited-a', alive: false }),
  ]);
});
