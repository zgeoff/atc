import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { toMessageID } from '@atc/core';
import type { SessionID } from '@atc/core';
import type { HookEvent } from '@atc/protocol/session';
import { createStateStore } from '@atc/store';
import { buildMockMessageRecord, createMigratedStateDB } from '@atc/store/testing';
import { buildStubClock, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import type { TapClient } from '../daemon-context';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { buildStubMessageBridges } from '../testing/build-stub-message-bridges';
import { createEventSignal } from '../transport/create-event-signal';
import { createIdempotencyLedger } from '../transport/create-idempotency-ledger';
import { createMessageBridges } from './create-message-bridges';
import { createMessageService } from './create-message-service';
import { createSessionManager } from './create-session-manager';
import { createSessionRuntime } from './create-session-runtime';
import type { SessionRuntime } from './create-session-runtime';
import { createTapRegistry } from './create-tap-registry';

// A session manager on one `local` target over the in-memory provider with
// one agent that takes its messages through a bridge in the daemon, a real
// state store, the message service, and the bridges over them.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-message-bridges-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const clock = buildStubClock(1_000_000);

  const runtimes = new Map<SessionID, SessionRuntime>();

  const stub = buildStubMessageBridges();

  const adapter = {
    ...buildStubHarnessAdapter({ takesMessages: true }),
    startMessageBridge: stub.startMessageBridge,
  };

  const manager = createSessionManager(
    null,
    store,
    join(temporaryDirectory.path, 'status.json'),
    [adapter],
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
          runtimes.set(session.id, createSessionRuntime());
        }
      },
    },
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  const taps = createTapRegistry<TapClient>();

  const messages = createMessageService({
    manager,
    store,
    clock,
    ledger: createIdempotencyLedger(store, 'local', () => {}, clock),
    taps,
    findRuntime: (id) => runtimes.get(id),
    eventSignal: createEventSignal(clock),
    emitEvent: () => {},
    findHookScope: () => null,
    isProcessEnded: () => false,
    tapGraceMs: 15_000,
  });

  const applyNote = mock<(hookEvent: HookEvent) => Promise<void>>(() => Promise.resolve());

  const bridges = createMessageBridges({
    manager,
    store,
    clock,
    messages,
    taps,
    applyNote,
    stateDir: join(temporaryDirectory.path, 'state'),
  });

  return { directory: temporaryDirectory.path, store, adapter, stub, manager, applyNote, bridges };
}

test('it starts the bridge of the agent a launch runs and answers with its plan', async () => {
  const ctx = await setupTest();
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  const plan = await ctx.bridges.startBridge({
    adapter: ctx.adapter,
    session: session.id,
    cwd: ctx.directory,
    env: {},
    withheldEnv: [],
    options: { prompt: '', resume: false },
  });

  expect(plan).toStrictEqual({ bin: 'stub-bridge', args: [] });

  expect(ctx.stub.requests).toMatchObject([
    {
      session: session.id,
      cwd: ctx.directory,
      directory: join(ctx.directory, 'state', 'sessions', session.id, 'codex'),
    },
  ]);
});

test('it answers no plan for an agent without a bridge', async () => {
  const ctx = await setupTest();
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  const plan = await ctx.bridges.startBridge({
    adapter: buildStubHarnessAdapter(),
    session: session.id,
    cwd: ctx.directory,
    env: {},
    withheldEnv: [],
    options: { prompt: '', resume: false },
  });

  expect(plan).toBeNull();
});

test('it stops the earlier bridge of a session a new launch starts', async () => {
  const ctx = await setupTest();
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  const launch = {
    adapter: ctx.adapter,
    session: session.id,
    cwd: ctx.directory,
    env: {},
    withheldEnv: [],
    options: { prompt: '', resume: false },
  } as const;

  await ctx.bridges.startBridge(launch);
  await ctx.bridges.startBridge(launch);

  expect(ctx.stub.bridges.map((bridge) => bridge.countStops())).toStrictEqual([1, 0]);
});

test('it stops every bridge when the daemon stops', async () => {
  const ctx = await setupTest();
  const one = await ctx.manager.spawn(ctx.directory, 'one', '', 80, 24);
  const two = await ctx.manager.spawn(ctx.directory, 'two', '', 80, 24);

  for (const session of [one, two]) {
    await ctx.bridges.startBridge({
      adapter: ctx.adapter,
      session: session.id,
      cwd: ctx.directory,
      env: {},
      withheldEnv: [],
      options: { prompt: '', resume: false },
    });
  }

  await ctx.bridges.stopAll();

  expect(ctx.stub.bridges.map((bridge) => bridge.countStops())).toStrictEqual([1, 1]);
});

test('it hands the start of delivery and a thread move to the bridge of the session', async () => {
  const ctx = await setupTest();
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  await ctx.bridges.startBridge({
    adapter: ctx.adapter,
    session: session.id,
    cwd: ctx.directory,
    env: {},
    withheldEnv: [],
    options: { prompt: '', resume: false },
  });

  ctx.bridges.startDelivery(session.id);
  ctx.bridges.updateThread(session.id, 'thread-2');

  const [bridge] = ctx.stub.bridges;

  invariant(bridge);

  expect(bridge.countDeliveryStarts()).toBe(1);
  expect(bridge.threads).toStrictEqual(['thread-2']);
});

test('it marks a message delivered when the bridge acks it', async () => {
  const ctx = await setupTest();
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  await ctx.store.writeMessage(
    buildMockMessageRecord({ id: toMessageID('m-1'), atcID: session.id }),
  );

  await ctx.bridges.startBridge({
    adapter: ctx.adapter,
    session: session.id,
    cwd: ctx.directory,
    env: {},
    withheldEnv: [],
    options: { prompt: '', resume: false },
  });

  const [request] = ctx.stub.requests;

  invariant(request);

  await request.host.ackMessage('m-1');

  const stored = await ctx.store.readMessageByID(toMessageID('m-1'));

  expect(stored?.status).toBe('delivered');
});

test('it lands a note the bridge reports as the reporter would', async () => {
  const ctx = await setupTest();
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  await ctx.bridges.startBridge({
    adapter: ctx.adapter,
    session: session.id,
    cwd: ctx.directory,
    env: {},
    withheldEnv: [],
    options: { prompt: '', resume: false },
  });

  const [request] = ctx.stub.requests;

  invariant(request);

  const payload = { kind: 'answered', messages: ['m-1'], answer: 'done' };

  const taken = await request.host.applyNote(payload);

  expect(taken).toBeTrue();

  expect(ctx.applyNote).toHaveBeenCalledExactlyOnceWith({
    atcId: session.id,
    event: 'Note',
    payload,
  });
});

test('it refuses a payload from the bridge that is no note', async () => {
  const ctx = await setupTest();
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  await ctx.bridges.startBridge({
    adapter: ctx.adapter,
    session: session.id,
    cwd: ctx.directory,
    env: {},
    withheldEnv: [],
    options: { prompt: '', resume: false },
  });

  const [request] = ctx.stub.requests;

  invariant(request);

  const taken = await request.host.applyNote({ kind: 'gossip' });

  expect(taken).toBeFalse();
  expect(ctx.applyNote).not.toHaveBeenCalled();
});

test('it lists the queued and delivered messages of the session as unsettled', async () => {
  const ctx = await setupTest();
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  await ctx.store.writeMessage(
    buildMockMessageRecord({ id: toMessageID('m-1'), atcID: session.id }),
  );

  await ctx.store.writeMessage(
    buildMockMessageRecord({ id: toMessageID('m-2'), atcID: session.id, status: 'delivered' }),
  );

  await ctx.store.writeMessage(
    buildMockMessageRecord({
      id: toMessageID('m-3'),
      atcID: session.id,
      status: 'answered',
      answer: 'done',
    }),
  );

  await ctx.bridges.startBridge({
    adapter: ctx.adapter,
    session: session.id,
    cwd: ctx.directory,
    env: {},
    withheldEnv: [],
    options: { prompt: '', resume: false },
  });

  const [request] = ctx.stub.requests;

  invariant(request);

  const unsettled = await request.host.readUnsettledMessages();

  expect(unsettled).toIncludeSameMembers([
    { id: 'm-1', status: 'queued' },
    { id: 'm-2', status: 'delivered' },
  ]);
});
