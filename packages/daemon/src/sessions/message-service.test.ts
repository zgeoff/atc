import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { toAgentSessionID, toMessageID, toSessionID } from '@atc/core';
import type { SessionID } from '@atc/core';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import { StateStore } from '@atc/store';
import { buildMockFleetEntry, createMigratedStateDB } from '@atc/store/testing';
import { buildStubClock, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import type { TapClient } from '../daemon-context';
import { updateEndedFleetMessages } from '../fleet/update-ended-fleet-messages';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { EventSignal } from '../transport/event-signal';
import { IdempotencyLedger } from '../transport/idempotency-ledger';
import { MessageService } from './message-service';
import { SessionRuntime } from './session-runtime';
import { SessionManager } from './sessions';
import { TapRegistry } from './tap-registry';

interface SetupTestConfig {
  // Whether the one agent takes inbox messages.
  readonly takesMessages: boolean;
}

async function setupTest(config: SetupTestConfig) {
  const temporaryDirectory = setupTempDir('atc-message-service-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const clock = buildStubClock(100_000);

  const runtimes = new Map<SessionID, SessionRuntime>();

  const manager = new SessionManager(
    null,
    store,
    join(temporaryDirectory.path, 'status.json'),
    [buildStubHarnessAdapter({ takesMessages: config.takesMessages })],
    [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
    ],
    [],
    {
      onEvent: (kind, session) => {
        if (kind === 'added') {
          runtimes.set(session.id, new SessionRuntime());
        }
      },
    },
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  const emitted: EventMsg[] = [];

  const ended = new Set<SessionID>();
  const taps = new TapRegistry<TapClient>();

  const messages = new MessageService({
    manager,
    store,
    clock,
    ledger: new IdempotencyLedger(store, 'local', () => {}, clock),
    taps,
    findRuntime: (id) => runtimes.get(id),
    eventSignal: new EventSignal(clock),
    emitEvent: (event) => {
      emitted.push(event);
    },
    findHookScope: () => null,
    isProcessEnded: (id) => ended.has(id),
    tapGraceMs: 15_000,
  });

  return {
    directory: temporaryDirectory.path,
    store,
    clock,
    manager,
    runtimes,
    emitted,
    ended,
    messages,
  };
}

test('it queues a message to a live session that takes messages', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  const answer = await ctx.messages.writeSessionMessage(
    session.id,
    { kind: 'owner' },
    'check the build',
    null,
    null,
    null,
  );

  invariant(typeof answer === 'object');

  const stored = await ctx.store.readMessageByID(toMessageID(answer.message));

  expect(answer.message).toStartWith('m-');
  expect(answer.status).toBe('queued');
  expect(stored).toMatchObject({ atcID: session.id, text: 'check the build', status: 'queued' });
});

test('it broadcasts the status of a message it writes', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  await ctx.messages.writeSessionMessage(session.id, { kind: 'owner' }, 'hello', null, null, null);

  expect(ctx.emitted).toPartiallyContain({ ev: 'SessionMessage', sessionID: session.id });
});

test('it refuses a message to a session the daemon does not hold as missing', async () => {
  const ctx = await setupTest({ takesMessages: true });

  const answer = await ctx.messages.writeSessionMessage(
    toSessionID('s-gone'),
    { kind: 'owner' },
    'hello',
    null,
    null,
    null,
  );

  expect(answer).toBe('missing');
});

test('it refuses a message to a session whose agent takes none as unsupported', async () => {
  const ctx = await setupTest({ takesMessages: false });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  const answer = await ctx.messages.writeSessionMessage(
    session.id,
    { kind: 'owner' },
    'hello',
    null,
    null,
    null,
  );

  expect(answer).toBe('unsupported');
});

test('it refuses a message to a started session that has gone without a tap past the grace window', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  const runtime = ctx.runtimes.get(session.id);

  invariant(runtime);

  runtime.startedAt = ctx.clock.now() - 15_000;

  const answer = await ctx.messages.writeSessionMessage(
    session.id,
    { kind: 'owner' },
    'hello',
    null,
    null,
    null,
  );

  expect(answer).toBe('no_tap');
});

test('it answers a retried keyed send with the first message and writes it once', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  const first = await ctx.messages.writeSessionMessage(
    session.id,
    { kind: 'owner' },
    'hello',
    { key: 'k-1', payloadHash: 'h-1' },
    null,
    null,
  );

  const second = await ctx.messages.writeSessionMessage(
    session.id,
    { kind: 'owner' },
    'hello',
    { key: 'k-1', payloadHash: 'h-1' },
    null,
    null,
  );

  const pending = await ctx.store.readPendingMessages({ atcID: session.id });

  expect(second).toStrictEqual(first);
  expect(pending).toHaveLength(1);
});

test('it hands a queued message to the tap that attaches', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  await ctx.messages.writeSessionMessage(session.id, { kind: 'owner' }, 'hello', null, null, null);

  const tap = { sendEvent: mock<TapClient['sendEvent']>() };

  ctx.messages.attachTap(tap, session.id, null, false);

  await ctx.messages.drainSessionInbox(session.id);

  expect(tap.sendEvent).toHaveBeenCalledWith(
    expect.objectContaining({ ev: 'InboxMessage', sessionID: session.id }),
  );
});

test('it closes the inbox of the tap a new tap replaces', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  const first = { sendEvent: mock<TapClient['sendEvent']>() };

  ctx.messages.attachTap(first, session.id, null, false);
  ctx.messages.attachTap({ sendEvent: mock<TapClient['sendEvent']>() }, session.id, null, false);

  expect(first.sendEvent).toHaveBeenCalledWith({
    version: PROTOCOL_V,
    ev: 'InboxClosed',
    sessionID: session.id,
    reason: 'replaced',
  });
});

test('it refuses a tap for a session whose agent takes no messages', async () => {
  const ctx = await setupTest({ takesMessages: false });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  expect(
    ctx.messages.attachTap({ sendEvent: mock<TapClient['sendEvent']>() }, session.id, null, false),
  ).toBe('unsupported');
});

test('it marks a tapped message delivered when the tap acks it', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  const tap = { sendEvent: mock<TapClient['sendEvent']>() };

  ctx.messages.attachTap(tap, session.id, null, false);

  const answer = await ctx.messages.writeSessionMessage(
    session.id,
    { kind: 'owner' },
    'hello',
    null,
    null,
    null,
  );

  invariant(typeof answer === 'object');

  const acked = await ctx.messages.ackMessage(tap, session.id, toMessageID(answer.message), null);

  expect(acked).toMatchObject({ id: answer.message, status: 'delivered' });
});

test('it refuses an ack from a client that is not the tap of the session', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  ctx.messages.attachTap({ sendEvent: mock<TapClient['sendEvent']>() }, session.id, null, false);

  const acked = await ctx.messages.ackMessage(
    { sendEvent: mock<TapClient['sendEvent']>() },
    session.id,
    toMessageID('m-1'),
    null,
  );

  expect(acked).toBe('not_tapping');
});

test('it marks each delivered message unanswered when the process of its session ends', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  const tap = { sendEvent: mock<TapClient['sendEvent']>() };

  ctx.messages.attachTap(tap, session.id, null, false);

  const answer = await ctx.messages.writeSessionMessage(
    session.id,
    { kind: 'owner' },
    'hello',
    null,
    null,
    null,
  );

  invariant(typeof answer === 'object');

  await ctx.messages.ackMessage(tap, session.id, toMessageID(answer.message), null);
  await ctx.messages.updateEndedSessionMessages(session);

  const stored = await ctx.store.readMessageByID(toMessageID(answer.message));

  expect(stored?.status).toBe('unanswered');
});

test('it reads a message the store does not hold as none', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const view = await ctx.messages.readMessage(toMessageID('m-gone'), 0);

  expect(view).toBeNull();
});

test('it reads a message under the live session it was sent to', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  const answer = await ctx.messages.writeSessionMessage(
    session.id,
    { kind: 'owner' },
    'hello',
    null,
    null,
    null,
  );

  invariant(typeof answer === 'object');

  const view = await ctx.messages.readMessage(toMessageID(answer.message), 0);

  expect(view).toMatchObject({
    session: session.id,
    record: { id: answer.message, status: 'queued' },
    answeredWith: [],
  });
});

test('it marks a delivered message of a revivable session unanswered for its sender at boot and queues it for no tap', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const sender = await ctx.manager.spawn(ctx.directory, 'sender', '', 80, 24);
  const recipient = await ctx.manager.spawn(ctx.directory, 'recipient', '', 80, 24);

  const tap = { sendEvent: mock<TapClient['sendEvent']>() };

  ctx.messages.attachTap(tap, recipient.id, null, false);

  const answer = await ctx.messages.writeSessionMessage(
    recipient.id,
    { kind: 'session', session: sender.id },
    'prune the stale branches',
    null,
    null,
    sender.id,
  );

  invariant(typeof answer === 'object');

  await ctx.messages.ackMessage(tap, recipient.id, toMessageID(answer.message), null);

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: recipient.id,
      agentSessionID: toAgentSessionID('agent-recipient'),
      agent: 'claude',
      target: 'local',
      targetIdentity: 'local-pty:test',
    }),
  ]);

  await updateEndedFleetMessages({
    manager: ctx.manager,
    store: ctx.store,
    messages: ctx.messages,
  });

  const stored = await ctx.store.readMessageByID(toMessageID(answer.message));
  const notices = await ctx.store.readPendingNotices(sender.id);
  const pending = await ctx.store.readPendingMessages({ atcID: recipient.id });

  expect(stored).toMatchObject({ status: 'unanswered', unansweredReason: 'session_ended' });
  expect(notices.map((record) => record.id)).toStrictEqual([toMessageID(answer.message)]);
  expect(pending).toStrictEqual([]);
});
