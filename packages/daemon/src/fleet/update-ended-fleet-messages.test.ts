import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { toAgentSessionID, toSessionID } from '@atc/core';
import type { SessionID } from '@atc/core';
import { StateStore } from '@atc/store';
import type { FleetEntry, MessageOwner } from '@atc/store';
import { buildMockFleetEntry, createMigratedStateDB } from '@atc/store/testing';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { updateEndedFleetMessages } from './update-ended-fleet-messages';

interface SetupConfig {
  readonly isRestoring: boolean;
  readonly revivable: readonly SessionID[];
}

// A real state store, a manager whose `local` target alone runs on the
// daemon's machine and that revives the sessions the test names, and
// recorders of the messages it marks and requeues and the lines it logs.
async function setupTest(config: SetupConfig) {
  const tmp = setupTempDir('atc-ended-fleet-messages-');
  const dbPath = join(tmp.path, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const log = mock<(line: string) => void>();

  const mgr = {
    isLocalTarget: (target: string) => target === 'local',
    isRevivable: (entry: FleetEntry) => config.revivable.includes(entry.sessionID),
    log,
  };

  const updateEndedMessages = mock<(sessionID: SessionID, owner: MessageOwner) => Promise<void>>(
    () => Promise.resolve(),
  );

  const updateRevivedMessages = mock<(sessionID: SessionID, owner: MessageOwner) => Promise<void>>(
    () => Promise.resolve(),
  );

  return {
    store,
    mgr,
    log,
    isRestoring: config.isRestoring,
    messages: { updateEndedMessages, updateRevivedMessages },
    updateEndedMessages,
    updateRevivedMessages,
  };
}

test('it marks the messages of each local session in the stored fleet', async () => {
  const ctx = await setupTest({ isRestoring: false, revivable: [] });

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
  const ctx = await setupTest({ isRestoring: false, revivable: [] });

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-1'), target: 'imp' }),
  ]);

  await updateEndedFleetMessages(ctx);

  expect(ctx.updateEndedMessages).not.toHaveBeenCalled();
});

test('it marks only its own messages when a live remote row holds the same agent session', async () => {
  const ctx = await setupTest({ isRestoring: false, revivable: [] });

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
  const ctx = await setupTest({ isRestoring: false, revivable: [] });

  await ctx.store.stop();

  await updateEndedFleetMessages(ctx);

  expect(ctx.updateEndedMessages).not.toHaveBeenCalled();
});

test('it requeues the messages of each local session the restore revives', async () => {
  const ctx = await setupTest({ isRestoring: true, revivable: [toSessionID('s-1')] });

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-1'),
      target: 'local',
      agentSessionID: toAgentSessionID('a-1'),
    }),
  ]);

  await updateEndedFleetMessages(ctx);

  expect(ctx.updateRevivedMessages).toHaveBeenCalledExactlyOnceWith(toSessionID('s-1'), {
    atcID: toSessionID('s-1'),
    agentSessionID: toAgentSessionID('a-1'),
  });

  expect(ctx.updateEndedMessages).not.toHaveBeenCalled();
});

test('it marks the messages of a local session the restore cannot revive', async () => {
  const ctx = await setupTest({ isRestoring: true, revivable: [] });

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

  expect(ctx.updateRevivedMessages).not.toHaveBeenCalled();
});

test('it logs a requeue that fails and marks those messages instead', async () => {
  const ctx = await setupTest({ isRestoring: true, revivable: [toSessionID('s-1')] });

  ctx.updateRevivedMessages.mockImplementation(() => Promise.reject(new Error('disk I/O error')));

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-1'),
      target: 'local',
      agentSessionID: toAgentSessionID('a-1'),
    }),
  ]);

  await updateEndedFleetMessages(ctx);

  expect(ctx.log).toHaveBeenCalledExactlyOnceWith(
    'atc could not requeue the messages of session s-1 for its revive (disk I/O error); it marks them unanswered',
  );

  expect(ctx.updateEndedMessages).toHaveBeenCalledExactlyOnceWith(toSessionID('s-1'), {
    atcID: toSessionID('s-1'),
    agentSessionID: toAgentSessionID('a-1'),
  });
});
