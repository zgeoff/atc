import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { toAgentSessionID, toSessionID } from '@atc/core';
import type { SessionID } from '@atc/core';
import type { AgentAdapter, HeadlessRunner } from '@atc/plugin-api';
import { StateStore } from '@atc/store';
import { createMigratedStateDB } from '@atc/store/testing';
import { buildStubClock, registerTestCleanup, setupTempDir, waitFor } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { TargetAccess } from '../auth/target-access';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { SessionHandoff } from './session-handoff';
import { SessionRuntime } from './session-runtime';
import { SessionManager } from './sessions';

interface SetupTestConfig {
  // The one agent the sessions run.
  readonly adapter: AgentAdapter;
}

// A session manager on one `local` target over the in-memory provider, a
// real state store, and the handoff over them; each session the manager
// announces gets the runtime the daemon gives it.
async function setupTest(config: SetupTestConfig) {
  const tmp = setupTempDir('atc-session-handoff-');
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const clock = buildStubClock(1_000_000);

  const runtimes = new Map<SessionID, SessionRuntime>();

  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const mgr = new SessionManager(
    null,
    store,
    join(tmp.dir, 'status.json'),
    [config.adapter],
    [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
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

  const startHeadlessTurn = mock<(sessionID: SessionID, prompt: string) => boolean>(() => true);
  const scheduleResize = mock<(sessionID: SessionID) => void>();

  const handoff = new SessionHandoff({
    mgr,
    findRuntime: (id) => runtimes.get(id),
    ejectSettleMs: 4000,
    scheduleEjectSettle: clock.schedule,
    startHeadlessTurn,
    scheduleResize,
  });

  return {
    dir: tmp.dir,
    clock,
    provider,
    mgr,
    runtimes,
    startHeadlessTurn,
    scheduleResize,
    handoff,
  };
}

test('it ends the terminal of an ejected session and starts its turn once the eject settles', async () => {
  const ctx = await setupTest({
    adapter: { ...buildStubHarnessAdapter(), headlessRunner: mock<HeadlessRunner>() },
  });

  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  s.agentSessionID = toAgentSessionID('a-1');

  const ejected = ctx.handoff.yankSession(s.id, 'finish the review');

  ctx.clock.advance(4000);

  expect(ejected).toBe('ok');
  expect(s.kind).toBe('headless');

  await waitFor(() => {
    expect(ctx.startHeadlessTurn).toHaveBeenCalledExactlyOnceWith(s.id, 'finish the review');
  });
});

test('it refuses to eject a session whose agent runs no headless turns', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  s.agentSessionID = toAgentSessionID('a-1');

  expect(ctx.handoff.yankSession(s.id, 'finish the review')).toBe('unsupported');
});

test('it refuses to eject a session whose conversation its agent cannot resume', async () => {
  const ctx = await setupTest({
    adapter: {
      ...buildStubHarnessAdapter(),
      headlessRunner: mock<HeadlessRunner>(),
      canResume: () => false,
    },
  });

  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const ejected = ctx.handoff.yankSession(s.id, 'finish the review');

  expect(ejected).toBe('no_transcript');
  expect(s.kind).toBe('pty');
});

test('it refuses to eject a session the manager does not hold', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });

  expect(ctx.handoff.yankSession(toSessionID('s-gone'), 'finish the review')).toBe('missing');
});

test('it starts a terminal that resumes an ended session and sizes it for its clients', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  s.agentSessionID = toAgentSessionID('a-1');

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitExit({ exitCode: 0 });

  await waitFor(() => {
    expect(s.pty).toBeNull();
  });

  const adopted = await ctx.handoff.adoptSession(s.id, 100, 30, null);

  expect(adopted).toBe('ok');
  expect(ctx.provider.harnesses).toHaveLength(2);
  expect(ctx.scheduleResize).toHaveBeenCalledExactlyOnceWith(s.id);
});

test('it stops the headless run of a session it adopts', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  s.agentSessionID = toAgentSessionID('a-1');

  ctx.mgr.yankHeadless(s.id);

  const runtime = ctx.runtimes.get(s.id);

  invariant(runtime);

  const stop = mock<() => void>();

  runtime.headlessRun = { stop };

  await ctx.handoff.adoptSession(s.id, 100, 30, null);

  expect(stop).toHaveBeenCalledOnce();
});

test('it refuses to adopt a session outside the access', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  s.agentSessionID = toAgentSessionID('a-1');

  ctx.mgr.yankHeadless(s.id);

  const access = new TargetAccess([{ target: 'imp', targetIdentity: 'imp:elsewhere' }]);

  const adopted = await ctx.handoff.adoptSession(s.id, 100, 30, access);

  expect(adopted).toBe('missing');
  expect(ctx.provider.harnesses).toHaveLength(1);
});

test('it refuses to adopt a session whose conversation its agent cannot resume', async () => {
  const ctx = await setupTest({
    adapter: { ...buildStubHarnessAdapter(), canResume: () => false },
  });

  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);
  const adopted = await ctx.handoff.adoptSession(s.id, 100, 30, null);

  expect(adopted).toBe('no_transcript');
});
