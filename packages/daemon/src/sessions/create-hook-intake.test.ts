import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import type { AdapterEvent } from '@atc/protocol';
import type { EventMsg } from '@atc/protocol/wire';
import { createStateStore } from '@atc/store';
import { buildMockMessageRecord } from '@atc/store/testing';
import {
  buildStubClock,
  buildStubLog,
  createMigratedStateDB,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { toAgentSessionID, toMessageID, toSessionID } from '@atcx/contract';
import type { SessionID } from '@atcx/contract';
import invariant from 'tiny-invariant';
import type { TapClient } from '../daemon-context';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { createEventSignal } from '../transport/create-event-signal';
import { createIdempotencyLedger } from '../transport/create-idempotency-ledger';
import { createHookIntake } from './create-hook-intake';
import { createMessageService } from './create-message-service';
import { createSessionManager } from './create-session-manager';
import { createSessionRuntime } from './create-session-runtime';
import type { SessionRuntime } from './create-session-runtime';
import { createTapRegistry } from './create-tap-registry';

interface SetupTestConfig {
  // The events each hook event name means to the one agent.
  readonly hooks: Readonly<Record<string, readonly Readonly<AdapterEvent>[]>>;
}

async function setupTest(config: SetupTestConfig) {
  const temporaryDirectory = setupTempDir('atc-hook-intake-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const clock = buildStubClock(1_000_000);

  const runtimes = new Map<SessionID, SessionRuntime>();

  const adapter = buildStubHarnessAdapter({ hooks: config.hooks, takesMessages: true });

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

  const recorder = buildStubLog();

  manager.log = recorder.log;

  const emitted: EventMsg[] = [];
  const eventSignal = createEventSignal(clock);
  const taps = createTapRegistry<TapClient>();

  const emitEvent = (event: EventMsg) => {
    emitted.push(event);
  };

  const messages = createMessageService({
    manager,
    store,
    clock,
    ledger: createIdempotencyLedger(store, 'local', () => {}, clock),
    taps,
    findRuntime: (id) => runtimes.get(id),
    eventSignal,
    emitEvent,
    findHookScope: () => null,
    isProcessEnded: () => false,
    tapGraceMs: 15_000,
  });

  const updateBridgeThread = mock<(sessionID: SessionID, agentSessionID: string) => void>();
  const onAgentStarted = mock<(sessionID: SessionID) => void>();
  const onNoteIgnored = mock<(sessionID: string, kind: string) => void>();
  const onLastUsedUnchanged = mock<(sessionID: SessionID) => void>();

  const hooks = createHookIntake({
    manager,
    store,
    clock,
    messages,
    taps,
    findRuntime: (id) => runtimes.get(id),
    eventSignal,
    emitEvent,
    findHookScope: () => null,
    updateBridgeThread,
    onAgentStarted,
    onNoteIgnored,
    onLastUsedUnchanged,
  });

  return {
    directory: temporaryDirectory.path,
    store,
    adapter,
    manager,
    runtimes,
    lines: recorder.lines,
    emitted,
    messages,
    updateBridgeThread,
    onAgentStarted,
    onNoteIgnored,
    onLastUsedUnchanged,
    hooks,
  };
}

test('it records a hook line in the trail under the event its adapter planned', async () => {
  const ctx = await setupTest({ hooks: { Stop: [{ kind: 'turn-done' }] } });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  ctx.hooks.applyHookEvent({ atcId: session.id, event: 'Stop', payload: {} });

  await waitFor(async () => {
    const rows = await ctx.store.readLatestEvents(10, null);

    expect(rows).toMatchObject([{ atcID: session.id, kind: 'turn-done' }]);
  });
});

test('it passes back the harness state the same session last returned', async () => {
  const ctx = await setupTest({ hooks: {} });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  ctx.hooks.applyHookEvent({ atcId: session.id, event: 'PreToolUse', payload: {} });
  ctx.hooks.applyHookEvent({ atcId: session.id, event: 'PreToolUse', payload: {} });

  expect(ctx.adapter.hookReads.map((read) => read.previous)).toStrictEqual([undefined, 1]);
});

test('it drops a hook line from a harness nested inside the session', async () => {
  const ctx = await setupTest({ hooks: {} });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  ctx.hooks.applyHookEvent({
    atcId: session.id,
    event: 'PreToolUse',
    payload: {},
    agent: 'claude',
  });

  ctx.hooks.applyHookEvent({ atcId: session.id, event: 'PreToolUse', payload: {}, agent: 'grok' });

  expect(ctx.adapter.hookReads).toHaveLength(1);
  expect(ctx.lines).toSatisfyAny((line: string) => line.startsWith('atc hook event=dropped'));
});

test('it writes the last-used agent when a spawned session reports its start', async () => {
  const ctx = await setupTest({ hooks: { SessionStart: [{ kind: 'started' }] } });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  const runtime = ctx.runtimes.get(session.id);

  invariant(runtime);

  runtime.pendingLastUsed = true;

  ctx.hooks.applyHookEvent({ atcId: session.id, event: 'SessionStart', payload: {} });

  await waitFor(async () => {
    const agent = await ctx.store.loadLastUsedAgent();

    expect(agent).toBe('claude');
  });
});

test('it leaves the last-used agent when no spawn waits on the start a session reports', async () => {
  const ctx = await setupTest({ hooks: { SessionStart: [{ kind: 'started' }] } });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  ctx.hooks.applyHookEvent({ atcId: session.id, event: 'SessionStart', payload: {} });

  expect(ctx.onLastUsedUnchanged).toHaveBeenCalledExactlyOnceWith(session.id);
});

test('it reports the start of a session agent so its tap is watched for', async () => {
  const ctx = await setupTest({ hooks: { SessionStart: [{ kind: 'started' }] } });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  ctx.hooks.applyHookEvent({ atcId: session.id, event: 'SessionStart', payload: {} });

  expect(ctx.onAgentStarted).toHaveBeenCalledExactlyOnceWith(session.id);
});

test('it moves the bridge to the conversation a session start shows', async () => {
  const ctx = await setupTest({
    hooks: { SessionStart: [{ kind: 'started', agentSessionID: toAgentSessionID('a-2') }] },
  });

  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  ctx.hooks.applyHookEvent({ atcId: session.id, event: 'SessionStart', payload: {} });

  expect(ctx.updateBridgeThread).toHaveBeenCalledExactlyOnceWith(session.id, 'a-2');
});

test('it records a note from a listed session and broadcasts it', async () => {
  const ctx = await setupTest({ hooks: {} });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  await ctx.hooks.applyNote({
    atcId: session.id,
    event: 'Note',
    payload: { kind: 'note', label: 'progress', text: 'halfway there' },
  });

  const rows = await ctx.store.readLatestEvents(10, null);

  expect(rows).toMatchObject([{ atcID: session.id, kind: 'note' }]);
  expect(ctx.emitted).toPartiallyContain({ ev: 'SessionNote', sessionID: session.id });
});

test('it ignores a note from a session the fleet does not list', async () => {
  const ctx = await setupTest({ hooks: {} });

  await ctx.hooks.applyNote({
    atcId: toSessionID('s-gone'),
    event: 'Note',
    payload: { kind: 'note', label: 'progress', text: 'halfway there' },
  });

  expect(ctx.onNoteIgnored).toHaveBeenCalledExactlyOnceWith('s-gone', 'note');
});

test('it answers the messages a turn answer names', async () => {
  const ctx = await setupTest({ hooks: {} });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  await ctx.store.writeMessage(
    buildMockMessageRecord({ id: toMessageID('m-1'), atcID: session.id, status: 'delivered' }),
  );

  await ctx.hooks.applyNote({
    atcId: session.id,
    event: 'Note',
    payload: { kind: 'answered', messages: ['m-1'], answer: 'all green' },
  });

  const stored = await ctx.store.readMessageByID(toMessageID('m-1'));

  expect(stored).toMatchObject({ status: 'answered', answer: 'all green' });
});

test('it ignores a turn answer that names no message the session holds', async () => {
  const ctx = await setupTest({ hooks: {} });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  await ctx.hooks.applyNote({
    atcId: session.id,
    event: 'Note',
    payload: { kind: 'answered', messages: ['m-gone'], answer: 'all green' },
  });

  expect(ctx.onNoteIgnored).toHaveBeenCalledExactlyOnceWith(session.id, 'answered');
});

test('it records a headless turn in the trail under a synthetic event', async () => {
  const ctx = await setupTest({ hooks: {} });
  const session = await ctx.manager.spawn(ctx.directory, 'worker', '', 80, 24);

  ctx.hooks.recordHeadlessTurnEvent(session.id, { kind: 'turn-done' });

  await waitFor(async () => {
    const rows = await ctx.store.readLatestEvents(10, null);

    expect(rows).toMatchObject([{ atcID: session.id, kind: 'turn-done' }]);
  });
});
