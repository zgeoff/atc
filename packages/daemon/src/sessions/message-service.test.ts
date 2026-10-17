import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { toMessageID, toSessionID } from '@atc/core';
import type { SessionID } from '@atc/core';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import { StateStore } from '@atc/store';
import { createMigratedStateDB } from '@atc/store/testing';
import { buildStubClock, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import type { TapClient } from '../daemon-context';
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
  const tmp = setupTempDir('atc-message-service-');
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const clock = buildStubClock(100_000);

  const runtimes = new Map<SessionID, SessionRuntime>();

  const mgr = new SessionManager(
    null,
    store,
    join(tmp.dir, 'status.json'),
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
      onEvent: (kind, s) => {
        if (kind === 'added') {
          runtimes.set(s.id, new SessionRuntime());
        }
      },
    },
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  const emitted: EventMsg[] = [];

  const ended = new Set<SessionID>();
  const taps = new TapRegistry<TapClient>();

  const messages = new MessageService({
    mgr,
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

  return { dir: tmp.dir, store, clock, mgr, runtimes, emitted, ended, messages };
}

test('it queues a message to a live session that takes messages', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const answer = await ctx.messages.writeSessionMessage(
    s.id,
    { kind: 'owner' },
    'check the build',
    null,
    null,
    null,
  );

  invariant(typeof answer === 'object');

  const stored = await ctx.store.findMessageByID(toMessageID(answer.message));

  expect(answer.message).toStartWith('m-');
  expect(answer.status).toBe('queued');
  expect(stored).toMatchObject({ atcID: s.id, text: 'check the build', status: 'queued' });
});

test('it broadcasts the status of a message it writes', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  await ctx.messages.writeSessionMessage(s.id, { kind: 'owner' }, 'hello', null, null, null);

  expect(ctx.emitted).toPartiallyContain({ ev: 'SessionMessage', s: s.id });
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
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const answer = await ctx.messages.writeSessionMessage(
    s.id,
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
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const runtime = ctx.runtimes.get(s.id);

  invariant(runtime);

  runtime.startedAt = ctx.clock.now() - 15_000;

  const answer = await ctx.messages.writeSessionMessage(
    s.id,
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
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const first = await ctx.messages.writeSessionMessage(
    s.id,
    { kind: 'owner' },
    'hello',
    { key: 'k-1', payloadHash: 'h-1' },
    null,
    null,
  );

  const second = await ctx.messages.writeSessionMessage(
    s.id,
    { kind: 'owner' },
    'hello',
    { key: 'k-1', payloadHash: 'h-1' },
    null,
    null,
  );

  const pending = await ctx.store.collectPendingMessages({ atcID: s.id });

  expect(second).toStrictEqual(first);
  expect(pending).toHaveLength(1);
});

test('it hands a queued message to the tap that attaches', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  await ctx.messages.writeSessionMessage(s.id, { kind: 'owner' }, 'hello', null, null, null);

  const tap = { sendEvent: mock<TapClient['sendEvent']>() };

  ctx.messages.attachTap(tap, s.id, null, false);

  await ctx.messages.drainSessionInbox(s.id);

  expect(tap.sendEvent).toHaveBeenCalledWith(
    expect.objectContaining({ ev: 'InboxMessage', s: s.id }),
  );
});

test('it closes the inbox of the tap a new tap replaces', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const first = { sendEvent: mock<TapClient['sendEvent']>() };

  ctx.messages.attachTap(first, s.id, null, false);
  ctx.messages.attachTap({ sendEvent: mock<TapClient['sendEvent']>() }, s.id, null, false);

  expect(first.sendEvent).toHaveBeenCalledWith({
    v: PROTOCOL_V,
    ev: 'InboxClosed',
    s: s.id,
    reason: 'replaced',
  });
});

test('it refuses a tap for a session whose agent takes no messages', async () => {
  const ctx = await setupTest({ takesMessages: false });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  expect(
    ctx.messages.attachTap({ sendEvent: mock<TapClient['sendEvent']>() }, s.id, null, false),
  ).toBe('unsupported');
});

test('it marks a tapped message delivered when the tap acks it', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const tap = { sendEvent: mock<TapClient['sendEvent']>() };

  ctx.messages.attachTap(tap, s.id, null, false);

  const answer = await ctx.messages.writeSessionMessage(
    s.id,
    { kind: 'owner' },
    'hello',
    null,
    null,
    null,
  );

  invariant(typeof answer === 'object');

  const acked = await ctx.messages.ackMessage(tap, s.id, toMessageID(answer.message), null);

  expect(acked).toMatchObject({ id: answer.message, status: 'delivered' });
});

test('it refuses an ack from a client that is not the tap of the session', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  ctx.messages.attachTap({ sendEvent: mock<TapClient['sendEvent']>() }, s.id, null, false);

  const acked = await ctx.messages.ackMessage(
    { sendEvent: mock<TapClient['sendEvent']>() },
    s.id,
    toMessageID('m-1'),
    null,
  );

  expect(acked).toBe('not_tapping');
});

test('it marks each delivered message unanswered when the process of its session ends', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const tap = { sendEvent: mock<TapClient['sendEvent']>() };

  ctx.messages.attachTap(tap, s.id, null, false);

  const answer = await ctx.messages.writeSessionMessage(
    s.id,
    { kind: 'owner' },
    'hello',
    null,
    null,
    null,
  );

  invariant(typeof answer === 'object');

  await ctx.messages.ackMessage(tap, s.id, toMessageID(answer.message), null);
  await ctx.messages.updateEndedSessionMessages(s);

  const stored = await ctx.store.findMessageByID(toMessageID(answer.message));

  expect(stored?.status).toBe('unanswered');
});

test('it reads a message the store does not hold as none', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const view = await ctx.messages.readMessage(toMessageID('m-gone'), 0);

  expect(view).toBeNull();
});

test('it reads a message under the live session it was sent to', async () => {
  const ctx = await setupTest({ takesMessages: true });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const answer = await ctx.messages.writeSessionMessage(
    s.id,
    { kind: 'owner' },
    'hello',
    null,
    null,
    null,
  );

  invariant(typeof answer === 'object');

  const view = await ctx.messages.readMessage(toMessageID(answer.message), 0);

  expect(view).toMatchObject({
    session: s.id,
    record: { id: answer.message, status: 'queued' },
    answeredWith: [],
  });
});
