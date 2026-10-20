import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { toAgentSessionID, toMessageID, toSessionID } from '@atc/core';
import type { SessionID } from '@atc/core';
import type { AdapterEvent } from '@atc/protocol';
import type { EventMsg } from '@atc/protocol/wire';
import { StateStore } from '@atc/store';
import { buildMockMessageRecord, createMigratedStateDB } from '@atc/store/testing';
import {
  buildStubClock,
  buildStubLog,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import type { TapClient } from '../daemon-context';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { EventSignal } from '../transport/event-signal';
import { IdempotencyLedger } from '../transport/idempotency-ledger';
import { HookIntake } from './hook-intake';
import { MessageService } from './message-service';
import { SessionRuntime } from './session-runtime';
import { SessionManager } from './sessions';
import { TapRegistry } from './tap-registry';

interface SetupTestConfig {
  // The events each hook event name means to the one agent.
  readonly hooks: Readonly<Record<string, readonly Readonly<AdapterEvent>[]>>;
}

async function setupTest(config: SetupTestConfig) {
  const tmp = setupTempDir('atc-hook-intake-');
  const dbPath = join(tmp.path, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const clock = buildStubClock(1_000_000);

  const runtimes = new Map<SessionID, SessionRuntime>();

  const adapter = buildStubHarnessAdapter({ hooks: config.hooks, takesMessages: true });

  const mgr = new SessionManager(
    null,
    store,
    join(tmp.path, 'status.json'),
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

  const recorder = buildStubLog();

  mgr.log = recorder.log;

  const emitted: EventMsg[] = [];

  const eventSignal = new EventSignal(clock);
  const taps = new TapRegistry<TapClient>();

  const emitEvent = (event: EventMsg) => {
    emitted.push(event);
  };

  const messages = new MessageService({
    mgr,
    store,
    clock,
    ledger: new IdempotencyLedger(store, 'local', () => {}, clock),
    taps,
    findRuntime: (id) => runtimes.get(id),
    eventSignal,
    emitEvent,
    findHookScope: () => null,
    isProcessEnded: () => false,
    tapGraceMs: 15_000,
  });

  const updateBridgeThread = mock<(sessionID: SessionID, agentSessionID: string) => void>();
  const onNoteIgnored = mock<(sessionID: string, kind: string) => void>();
  const onLastUsedUnchanged = mock<(sessionID: SessionID) => void>();

  const hooks = new HookIntake({
    mgr,
    store,
    clock,
    messages,
    taps,
    findRuntime: (id) => runtimes.get(id),
    eventSignal,
    emitEvent,
    findHookScope: () => null,
    updateBridgeThread,
    onNoteIgnored,
    onLastUsedUnchanged,
  });

  return {
    dir: tmp.path,
    store,
    adapter,
    mgr,
    runtimes,
    lines: recorder.lines,
    emitted,
    messages,
    updateBridgeThread,
    onNoteIgnored,
    onLastUsedUnchanged,
    hooks,
  };
}

test('it records a hook line in the trail under the event its adapter planned', async () => {
  const ctx = await setupTest({ hooks: { Stop: [{ kind: 'turn-done' }] } });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  ctx.hooks.applyHookEvent({ atcId: s.id, event: 'Stop', payload: {} });

  await waitFor(async () => {
    const rows = await ctx.store.readLatestEvents(10, null);

    expect(rows).toMatchObject([{ atcID: s.id, kind: 'turn-done' }]);
  });
});

test('it passes back the harness state the same session last returned', async () => {
  const ctx = await setupTest({ hooks: {} });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  ctx.hooks.applyHookEvent({ atcId: s.id, event: 'PreToolUse', payload: {} });
  ctx.hooks.applyHookEvent({ atcId: s.id, event: 'PreToolUse', payload: {} });

  expect(ctx.adapter.hookReads.map((read) => read.prev)).toStrictEqual([undefined, 1]);
});

test('it drops a hook line from a harness nested inside the session', async () => {
  const ctx = await setupTest({ hooks: {} });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  ctx.hooks.applyHookEvent({ atcId: s.id, event: 'PreToolUse', payload: {}, agent: 'claude' });
  ctx.hooks.applyHookEvent({ atcId: s.id, event: 'PreToolUse', payload: {}, agent: 'grok' });

  expect(ctx.adapter.hookReads).toHaveLength(1);
  expect(ctx.lines).toSatisfyAny((line: string) => line.startsWith('atc hook event=dropped'));
});

test('it writes the last-used agent when a spawned session reports its start', async () => {
  const ctx = await setupTest({ hooks: { SessionStart: [{ kind: 'started' }] } });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const runtime = ctx.runtimes.get(s.id);

  invariant(runtime);

  runtime.pendingLastUsed = true;

  ctx.hooks.applyHookEvent({ atcId: s.id, event: 'SessionStart', payload: {} });

  await waitFor(async () => {
    const agent = await ctx.store.loadLastUsedAgent();

    expect(agent).toBe('claude');
  });
});

test('it leaves the last-used agent when no spawn waits on the start a session reports', async () => {
  const ctx = await setupTest({ hooks: { SessionStart: [{ kind: 'started' }] } });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  ctx.hooks.applyHookEvent({ atcId: s.id, event: 'SessionStart', payload: {} });

  expect(ctx.onLastUsedUnchanged).toHaveBeenCalledExactlyOnceWith(s.id);
});

test('it moves the bridge to the conversation a session start shows', async () => {
  const ctx = await setupTest({
    hooks: { SessionStart: [{ kind: 'started', agentSessionID: toAgentSessionID('a-2') }] },
  });

  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  ctx.hooks.applyHookEvent({ atcId: s.id, event: 'SessionStart', payload: {} });

  expect(ctx.updateBridgeThread).toHaveBeenCalledExactlyOnceWith(s.id, 'a-2');
});

test('it records a note from a listed session and broadcasts it', async () => {
  const ctx = await setupTest({ hooks: {} });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  await ctx.hooks.applyNote({
    atcId: s.id,
    event: 'Note',
    payload: { kind: 'note', label: 'progress', text: 'halfway there' },
  });

  const rows = await ctx.store.readLatestEvents(10, null);

  expect(rows).toMatchObject([{ atcID: s.id, kind: 'note' }]);
  expect(ctx.emitted).toPartiallyContain({ ev: 'SessionNote', s: s.id });
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
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  await ctx.store.writeMessage(
    buildMockMessageRecord({ id: toMessageID('m-1'), atcID: s.id, status: 'delivered' }),
  );

  await ctx.hooks.applyNote({
    atcId: s.id,
    event: 'Note',
    payload: { kind: 'answered', messages: ['m-1'], answer: 'all green' },
  });

  const stored = await ctx.store.readMessageByID(toMessageID('m-1'));

  expect(stored).toMatchObject({ status: 'answered', answer: 'all green' });
});

test('it ignores a turn answer that names no message the session holds', async () => {
  const ctx = await setupTest({ hooks: {} });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  await ctx.hooks.applyNote({
    atcId: s.id,
    event: 'Note',
    payload: { kind: 'answered', messages: ['m-gone'], answer: 'all green' },
  });

  expect(ctx.onNoteIgnored).toHaveBeenCalledExactlyOnceWith(s.id, 'answered');
});

test('it records a headless turn in the trail under a synthetic event', async () => {
  const ctx = await setupTest({ hooks: {} });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  ctx.hooks.recordHeadlessTurnEvent(s.id, { kind: 'turn-done' });

  await waitFor(async () => {
    const rows = await ctx.store.readLatestEvents(10, null);

    expect(rows).toMatchObject([{ atcID: s.id, kind: 'turn-done' }]);
  });
});
