import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { toAgentSessionID, toSessionID } from '@atc/core';
import type { SessionID } from '@atc/core';
import { StateStore } from '@atc/store';
import type { MessageOwner } from '@atc/store';
import { buildMockFleetEntry, createMigratedStateDB } from '@atc/store/testing';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { updateEndedFleetMessages } from './update-ended-fleet-messages';

// A real state store, a manager whose `local` target alone runs on the
// daemon's machine, and a recorder of the messages it marks.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-ended-fleet-messages-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

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
