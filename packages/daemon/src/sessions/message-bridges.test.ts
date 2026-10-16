import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { toMessageID } from '@atc/core';
import type { SessionID } from '@atc/core';
import type { HookEvent } from '@atc/protocol/session';
import { StateStore } from '@atc/store';
import { buildMockMessageRecord, createMigratedStateDB } from '@atc/store/testing';
import { buildStubClock, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import type { TapClient } from '../daemon-context';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { buildStubMessageBridges } from '../testing/build-stub-message-bridges';
import { EventSignal } from '../transport/event-signal';
import { IdempotencyLedger } from '../transport/idempotency-ledger';
import { MessageBridges } from './message-bridges';
import { MessageService } from './message-service';
import { SessionRuntime } from './session-runtime';
import { SessionManager } from './sessions';
import { TapRegistry } from './tap-registry';

// A session manager on one `local` target over the in-memory provider with
// one agent that takes its messages through a bridge in the daemon, a real
// state store, the message service, and the bridges over them.
async function setupTest() {
  const tmp = setupTempDir('atc-message-bridges-');
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const clock = buildStubClock(1_000_000);

  const runtimes = new Map<SessionID, SessionRuntime>();

  const stub = buildStubMessageBridges();

  const adapter = {
    ...buildStubHarnessAdapter({ takesMessages: true }),
    startMessageBridge: stub.startMessageBridge,
  };

  const mgr = new SessionManager(
    null,
    store,
    join(tmp.dir, 'status.json'),
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

  const taps = new TapRegistry<TapClient>();

  const messages = new MessageService({
    mgr,
    store,
    clock,
    ledger: new IdempotencyLedger(store, 'local', () => {}, clock),
    taps,
    findRuntime: (id) => runtimes.get(id),
    eventSignal: new EventSignal(clock),
    emitEvent: () => {},
    findHookScope: () => null,
    isProcessEnded: () => false,
    tapGraceMs: 15_000,
  });

  const applyNote = mock<(e: HookEvent) => Promise<void>>(() => Promise.resolve());

  const bridges = new MessageBridges({
    mgr,
    store,
    clock,
    messages,
    taps,
    applyNote,
    stateDir: join(tmp.dir, 'state'),
  });

  return { dir: tmp.dir, store, adapter, stub, mgr, applyNote, bridges };
}

test('it starts the bridge of the agent a launch runs and answers with its plan', async () => {
  const ctx = await setupTest();
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const plan = await ctx.bridges.startBridge({
    adapter: ctx.adapter,
    session: s.id,
    cwd: ctx.dir,
    env: {},
    withheldEnv: [],
    options: { prompt: '', resume: false },
  });

  expect(plan).toStrictEqual({ bin: 'stub-bridge', args: [] });

  expect(ctx.stub.requests).toMatchObject([
    { session: s.id, cwd: ctx.dir, dir: join(ctx.dir, 'state', 'sessions', s.id, 'codex') },
  ]);
});

test('it answers no plan for an agent without a bridge', async () => {
  const ctx = await setupTest();
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const plan = await ctx.bridges.startBridge({
    adapter: buildStubHarnessAdapter(),
    session: s.id,
    cwd: ctx.dir,
    env: {},
    withheldEnv: [],
    options: { prompt: '', resume: false },
  });

  expect(plan).toBeNull();
});

test('it stops the earlier bridge of a session a new launch starts', async () => {
  const ctx = await setupTest();
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const launch = {
    adapter: ctx.adapter,
    session: s.id,
    cwd: ctx.dir,
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
  const one = await ctx.mgr.spawn(ctx.dir, 'one', '', 80, 24);
  const two = await ctx.mgr.spawn(ctx.dir, 'two', '', 80, 24);

  for (const s of [one, two]) {
    await ctx.bridges.startBridge({
      adapter: ctx.adapter,
      session: s.id,
      cwd: ctx.dir,
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
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  await ctx.bridges.startBridge({
    adapter: ctx.adapter,
    session: s.id,
    cwd: ctx.dir,
    env: {},
    withheldEnv: [],
    options: { prompt: '', resume: false },
  });

  ctx.bridges.startDelivery(s.id);
  ctx.bridges.updateThread(s.id, 'thread-2');

  const [bridge] = ctx.stub.bridges;

  invariant(bridge);

  expect(bridge.countDeliveryStarts()).toBe(1);
  expect(bridge.threads).toStrictEqual(['thread-2']);
});

test('it marks a message delivered when the bridge acks it', async () => {
  const ctx = await setupTest();
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  await ctx.store.writeMessage(buildMockMessageRecord({ id: toMessageID('m-1'), atcID: s.id }));

  await ctx.bridges.startBridge({
    adapter: ctx.adapter,
    session: s.id,
    cwd: ctx.dir,
    env: {},
    withheldEnv: [],
    options: { prompt: '', resume: false },
  });

  const [request] = ctx.stub.requests;

  invariant(request);

  await request.host.ackMessage('m-1');

  const stored = await ctx.store.findMessageByID(toMessageID('m-1'));

  expect(stored?.status).toBe('delivered');
});

test('it lands a note the bridge reports as the reporter would', async () => {
  const ctx = await setupTest();
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  await ctx.bridges.startBridge({
    adapter: ctx.adapter,
    session: s.id,
    cwd: ctx.dir,
    env: {},
    withheldEnv: [],
    options: { prompt: '', resume: false },
  });

  const [request] = ctx.stub.requests;

  invariant(request);

  const payload = { kind: 'answered', messages: ['m-1'], answer: 'done' };

  const taken = await request.host.applyNote(payload);

  expect(taken).toBeTrue();
  expect(ctx.applyNote).toHaveBeenCalledExactlyOnceWith({ atcId: s.id, event: 'Note', payload });
});

test('it refuses a payload from the bridge that is no note', async () => {
  const ctx = await setupTest();
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  await ctx.bridges.startBridge({
    adapter: ctx.adapter,
    session: s.id,
    cwd: ctx.dir,
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
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  await ctx.store.writeMessage(buildMockMessageRecord({ id: toMessageID('m-1'), atcID: s.id }));

  await ctx.store.writeMessage(
    buildMockMessageRecord({ id: toMessageID('m-2'), atcID: s.id, status: 'delivered' }),
  );

  await ctx.store.writeMessage(
    buildMockMessageRecord({
      id: toMessageID('m-3'),
      atcID: s.id,
      status: 'answered',
      answer: 'done',
    }),
  );

  await ctx.bridges.startBridge({
    adapter: ctx.adapter,
    session: s.id,
    cwd: ctx.dir,
    env: {},
    withheldEnv: [],
    options: { prompt: '', resume: false },
  });

  const [request] = ctx.stub.requests;

  invariant(request);

  const unsettled = await request.host.collectUnsettledMessages();

  expect(unsettled).toIncludeSameMembers([
    { id: 'm-1', status: 'queued' },
    { id: 'm-2', status: 'delivered' },
  ]);
});
