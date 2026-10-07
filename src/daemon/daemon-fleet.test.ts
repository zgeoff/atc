import { expect, test } from 'bun:test';
import { getRecord } from '../shared/get-record';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { startTestDaemon } from '../test-utils/start-test-daemon';

test('it keeps every stored fleet row restorable when a spawn writes the fleet before the restore', async () => {
  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-fleet-',
    options: async (paths) => {
      await using stack = new AsyncDisposableStack();

      const store = await StateStore.open(paths.dbPath);

      stack.defer(() => store.stop());

      await store.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-live-a'), name: 'live-a', cwd: paths.dir }),
        buildMockFleetEntry({ sessionID: toSessionID('s-live-b'), name: 'live-b', cwd: paths.dir }),
        buildMockFleetEntry({
          sessionID: toSessionID('s-exited-a'),
          name: 'exited-a',
          cwd: paths.dir,
          exited: true,
        }),
        buildMockFleetEntry({
          sessionID: toSessionID('s-exited-b'),
          name: 'exited-b',
          cwd: paths.dir,
          exited: true,
        }),
      ]);

      return { adapter: buildMockAgentAdapter() };
    },
  });

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    agent: 'claude',
    name: 'fresh',
    cols: 80,
    rows: 24,
  });

  const restored = await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  const listed = await daemon.client.sendRequest('session.list');

  expect(restored).toStrictEqual({ restored: 4 });

  expect(listed['sessions']).toIncludeSameMembers([
    expect.objectContaining({ id: 's-live-a', name: 'live-a', alive: true }),
    expect.objectContaining({ id: 's-live-b', name: 'live-b', alive: true }),
    expect.objectContaining({ id: 's-exited-a', name: 'exited-a', alive: false }),
    expect.objectContaining({ id: 's-exited-b', name: 'exited-b', alive: false }),
    expect.objectContaining({ name: 'fresh', alive: true }),
  ]);
});

test('it keeps every stored fleet row when a rename and a deliberate kill write the fleet before the restore', async () => {
  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-fleet-',
    options: async (paths) => {
      await using stack = new AsyncDisposableStack();

      const store = await StateStore.open(paths.dbPath);

      stack.defer(() => store.stop());

      await store.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-live-a'), name: 'live-a', cwd: paths.dir }),
        buildMockFleetEntry({
          sessionID: toSessionID('s-exited-a'),
          name: 'exited-a',
          cwd: paths.dir,
          exited: true,
        }),
      ]);

      return { adapter: buildMockAgentAdapter() };
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    agent: 'claude',
    name: 'fresh',
    cols: 80,
    rows: 24,
  });

  const sessionID = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.update', { session: sessionID, name: 'renamed' });
  await daemon.client.sendRequest('session.kill', { session: sessionID });
  await daemon.client.sendRequest('session.kill', { session: sessionID });

  const restored = await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  const listed = await daemon.client.sendRequest('session.list');

  expect(restored).toStrictEqual({ restored: 2 });

  expect(listed['sessions']).toIncludeSameMembers([
    expect.objectContaining({ id: 's-live-a', name: 'live-a', alive: true }),
    expect.objectContaining({ id: 's-exited-a', name: 'exited-a', alive: false }),
  ]);
});
