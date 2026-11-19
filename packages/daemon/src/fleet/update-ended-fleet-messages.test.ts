import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { createStateStore } from '@atc/store';
import type { MessageOwner } from '@atc/store';
import { buildMockFleetEntry } from '@atc/store/test-utils/build-mock-fleet-entry';
import { createMigratedStateDB } from '@atc/store/test-utils/create-migrated-state-db';
import { toAgentSessionID, toSessionID } from '@atcx/contract';
import type { SessionID } from '@atcx/contract';
import { updateEndedFleetMessages } from './update-ended-fleet-messages';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-ended-fleet-messages-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const manager = {
    isLocalTarget: (target: string) => target === 'local',
  };

  const updateEndedMessages = mock<(sessionID: SessionID, owner: MessageOwner) => Promise<void>>(
    () => Promise.resolve(),
  );

  return {
    store,
    manager,
    messages: { updateEndedMessages },
    updateEndedMessages,
  };
}

test('it marks the messages of each local session in the stored fleet', async () => {
  const ctx = await setupTest();

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-1'),
      target: 'local',
      agentSessionID: toAgentSessionID('a-1'),
    }),
  ]);

  await updateEndedFleetMessages(ctx);

  expect(ctx.updateEndedMessages).toHaveBeenCalledExactlyOnceWith(toSessionID('s-1'), {
    atcID: toSessionID('s-1'),
    agentSessionID: toAgentSessionID('a-1'),
  });
});

test('it leaves the messages of a remote session', async () => {
  const ctx = await setupTest();

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-1'), target: 'imp' }),
  ]);

  await updateEndedFleetMessages(ctx);

  expect(ctx.updateEndedMessages).not.toHaveBeenCalled();
});

test('it marks only its own messages when a live remote row holds the same agent session', async () => {
  const ctx = await setupTest();

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-1'),
      target: 'local',
      agentSessionID: toAgentSessionID('a-1'),
    }),
    buildMockFleetEntry({
      sessionID: toSessionID('s-2'),
      target: 'imp',
      agentSessionID: toAgentSessionID('a-1'),
      exited: false,
    }),
  ]);

  await updateEndedFleetMessages(ctx);

  expect(ctx.updateEndedMessages).toHaveBeenCalledExactlyOnceWith(toSessionID('s-1'), {
    atcID: toSessionID('s-1'),
  });
});

test('it leaves every message when the stored fleet cannot be read', async () => {
  const ctx = await setupTest();

  await ctx.store.stop();

  await updateEndedFleetMessages(ctx);

  expect(ctx.updateEndedMessages).not.toHaveBeenCalled();
});
