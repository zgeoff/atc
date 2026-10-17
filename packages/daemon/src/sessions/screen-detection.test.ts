import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import type { SessionID } from '@atc/core';
import type { AgentAdapter } from '@atc/plugin-api';
import { StateStore } from '@atc/store';
import { createMigratedStateDB } from '@atc/store/testing';
import { buildStubClock, registerTestCleanup, setupTempDir, waitFor } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { ScreenDetection } from './screen-detection';
import { ScreenModel } from './screen-model';
import { SessionRuntime } from './session-runtime';
import { SessionManager } from './sessions';

interface SetupTestConfig {
  // The agents the sessions may run.
  readonly adapters: readonly AgentAdapter[];
}

async function setupTest(config: SetupTestConfig) {
  const tmp = setupTempDir('atc-screen-detection-');
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
    [...config.adapters],
    [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
    [],
    {
      onEvent: (kind, s) => {
        if (kind === 'added') {
          runtimes.set(s.id, new SessionRuntime());
        }
      },
      onBoot: (s, cols, rows) => {
        const runtime = runtimes.get(s.id);

        if (runtime !== undefined) {
          runtime.screen ??= new ScreenModel(cols, rows);
        }
      },
      onOutput: (s, data) => {
        runtimes.get(s.id)?.screen?.record(data);
        detection.scheduleDetect(s.id);
      },
    },
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  const onDetectSkipped = mock<(sessionID: SessionID) => void>();

  const detection = new ScreenDetection({
    mgr,
    clock,
    findRuntime: (id) => runtimes.get(id),
    onDetectSkipped,
  });

  return { dir: tmp.dir, clock, provider, mgr, onDetectSkipped };
}

test('it moves a session waiting at a prompt to needs_you once its output goes quiet', async () => {
  const ctx = await setupTest({
    adapters: [
      {
        ...buildStubHarnessAdapter(),
        screenDetector: {
          detectAttention: (screen) =>
            screen.trimEnd().endsWith('READY>') ? 'needs-input' : 'working',
        },
      },
    ],
  });

  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('READY>');
  ctx.clock.advance(300);

  await waitFor(() => {
    expect(s.state).toBe('needs_you');
  });

  expect(s.lastMsg).toBe('waiting at a prompt');
});

test('it moves a session back to running once its screen shows work', async () => {
  const ctx = await setupTest({
    adapters: [
      {
        ...buildStubHarnessAdapter(),
        screenDetector: { detectAttention: () => 'working' },
      },
    ],
  });

  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  ctx.mgr.updateAttention(s.id, 'needs_you', 'Allow the edit?');

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('compiling');
  ctx.clock.advance(300);

  await waitFor(() => {
    expect(s.state).toBe('running');
  });
});

test('it restarts the wait on each output', async () => {
  const ctx = await setupTest({
    adapters: [
      {
        ...buildStubHarnessAdapter(),
        screenDetector: { detectAttention: () => 'working' },
      },
    ],
  });

  await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('compiling');
  ctx.clock.advance(200);
  harness.emitData('linking');
  ctx.clock.advance(200);

  expect(ctx.clock.collectPending()).toStrictEqual([100]);
});

test('it skips the screen of a session whose agents have no screen detector', async () => {
  const ctx = await setupTest({ adapters: [buildStubHarnessAdapter()] });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('READY>');

  expect(ctx.onDetectSkipped).toHaveBeenCalledExactlyOnceWith(s.id);
  expect(ctx.clock.collectPending()).toBeEmpty();
});

test('it skips the screen of a session whose agent has no screen detector while another agent has one', async () => {
  const ctx = await setupTest({
    adapters: [
      buildStubHarnessAdapter(),
      {
        ...buildStubHarnessAdapter({ id: 'grok' }),
        screenDetector: { detectAttention: () => 'needs-input' },
      },
    ],
  });

  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('READY>');

  expect(ctx.onDetectSkipped).toHaveBeenCalledExactlyOnceWith(s.id);
  expect(ctx.clock.collectPending()).toBeEmpty();
});
