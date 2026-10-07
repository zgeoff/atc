import { expect, test } from 'bun:test';
import { faker } from '@faker-js/faker';
import type { AgentID } from '../shared/agent-id';
import { getRecord } from '../shared/get-record';
import { toSessionID } from '../shared/to-session-id';
import type { FleetEntry } from '../store/fleet-entry';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';

interface SetupConfig {
  // The fleet stored before the daemon boots, given the daemon's temp
  // directory.
  readonly fleet: (dir: string) => readonly FleetEntry[];

  // The last-used agent stored before the daemon boots.
  readonly lastUsedAgent: AgentID;
}

/**
 * A real daemon over a state store seeded with a fleet and a last-used
 * agent, with an idle `claude` adapter and an idle `grok` adapter that reads
 * every hook as the session's start.
 */
function setupTest(config: SetupConfig) {
  return startTestDaemon({
    prefix: 'atc-daemon-last-used-',
    options: async (paths) => {
      await using stack = new AsyncDisposableStack();

      const store = await StateStore.open(paths.dbPath);

      stack.defer(() => store.stop());

      await store.writeFleet([...config.fleet(paths.dir)]);
      await store.writeLastUsedAgent(config.lastUsedAgent);

      return {
        adapter: buildMockAgentAdapter(),
        adapters: [
          buildMockAgentAdapter({ id: 'grok', normalizeHook: () => ({ kind: 'started' }) }),
        ],
      };
    },
  });
}

test('it keeps the last-used agent when a restored session reports its start', async () => {
  const sessionID = toSessionID(faker.string.uuid());

  await using ctx = await setupTest({
    fleet: (dir) => [buildMockFleetEntry({ sessionID, cwd: dir, agent: 'grok' })],
    lastUsedAgent: 'claude',
  });

  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  await ctx.sendHookLines({ atcId: sessionID, event: 'SessionStart', payload: {} });

  await waitFor(() => {
    expect(ctx.logs).toContain(
      `atc daemon: session ${sessionID} started outside a spawn; the last-used agent is unchanged`,
    );
  });

  const probe = await ctx.openClient();

  expect(probe.sendHello(ctx.build)).resolves.toMatchObject({ lastUsedAgent: 'claude' });
});

test('it writes the last-used agent when a spawned session reports its start', async () => {
  await using ctx = await setupTest({ fleet: () => [], lastUsedAgent: 'claude' });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.sendHookLines({ atcId: id, event: 'SessionStart', payload: {} });

  await waitFor(async () => {
    const probe = await ctx.openClient();
    const hello = await probe.sendHello(ctx.build);

    expect(hello).toMatchObject({ lastUsedAgent: 'grok' });
  });
});
