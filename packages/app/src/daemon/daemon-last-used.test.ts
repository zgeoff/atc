// oxlint-disable zgeoff/test-beside-module -- a daemon.ts topic test, moved by the daemon split (GEO-401)
import { expect, test } from 'bun:test';
import type { SessionID } from '@atc/core';
import { toSessionID } from '@atc/core';
import { StateStore } from '@atc/store';
import { buildMockFleetEntry } from '@atc/store/testing';
import { buildMockAgentAdapter, getRecord, registerTestCleanup, waitFor } from '@atc/test-utils';
import { faker } from '@faker-js/faker';
import { startTestDaemon } from '../test-utils/start-test-daemon';

test('it keeps the last-used agent when a restored session reports its start', async () => {
  const sessionID = toSessionID(faker.string.uuid());
  const unchanged: SessionID[] = [];

  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-last-used-',
    options: async (paths) => {
      const store = await StateStore.open(paths.dbPath);

      const stopStore = registerTestCleanup(() => store.stop());

      await store.writeFleet([buildMockFleetEntry({ sessionID, cwd: paths.dir, agent: 'grok' })]);
      await store.writeLastUsedAgent('claude');

      await stopStore();

      return {
        adapter: buildMockAgentAdapter(),
        adapters: [
          buildMockAgentAdapter({
            id: 'grok',
            planHookEvents: () => ({ events: [{ kind: 'started' }] }),
          }),
        ],
        onLastUsedUnchanged: (id: SessionID) => {
          unchanged.push(id);
        },
      };
    },
  });

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  await daemon.sendHookLines({ atcId: sessionID, event: 'SessionStart', payload: {} });

  await waitFor(() => {
    expect(unchanged).toStrictEqual([sessionID]);
  });

  const probe = await daemon.openClient();
  const hello = await probe.sendHello(daemon.build);

  expect(hello).toMatchObject({ lastUsedAgent: 'claude' });
});

test('it writes the last-used agent when a spawned session reports its start', async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-last-used-',
    options: async (paths) => {
      const store = await StateStore.open(paths.dbPath);

      const stopStore = registerTestCleanup(() => store.stop());

      await store.writeLastUsedAgent('claude');

      await stopStore();

      return {
        adapter: buildMockAgentAdapter(),
        adapters: [
          buildMockAgentAdapter({
            id: 'grok',
            planHookEvents: () => ({ events: [{ kind: 'started' }] }),
          }),
        ],
      };
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.sendHookLines({ atcId: id, event: 'SessionStart', payload: {} });

  await waitFor(async () => {
    const probe = await daemon.openClient();
    const hello = await probe.sendHello(daemon.build);

    expect(hello).toMatchObject({ lastUsedAgent: 'grok' });
  });
});
