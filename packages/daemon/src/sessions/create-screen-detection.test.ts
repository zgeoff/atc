import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import type { AgentAdapter } from '@atc/plugin-api';
import { createStateStore } from '@atc/store';
import {
  buildStubClock,
  createMigratedStateDB,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import type { SessionID } from '@atcx/contract';
import invariant from 'tiny-invariant';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { createScreenDetection } from './create-screen-detection';
import { createScreenModel } from './create-screen-model';
import { createSessionManager } from './create-session-manager';
import { createSessionRuntime } from './create-session-runtime';
import type { SessionRuntime } from './create-session-runtime';

interface SetupTestConfig {
  // The agents the sessions may run.
  readonly adapters: readonly AgentAdapter[];
}

async function setupTest(config: SetupTestConfig) {
  const temporaryDirectory = setupTempDir('atc-screen-detection-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const clock = buildStubClock(1_000_000);

  const runtimes = new Map<SessionID, SessionRuntime>();

  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const manager = createSessionManager({
    fallback: null,
    store,
    statusPath: join(temporaryDirectory.path, 'status.json'),
    adapters: [...config.adapters],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
    events: {
      onEvent: (kind, session) => {
        if (kind === 'added') {
          runtimes.set(session.id, createSessionRuntime());
        }
      },
      onBoot: (session, cols, rows) => {
        const runtime = runtimes.get(session.id);

        if (runtime !== undefined) {
          runtime.screen ??= createScreenModel(cols, rows);
        }
      },
      onOutput: (session, data) => {
        runtimes.get(session.id)?.screen?.record(data);
        detection.scheduleDetect(session.id);
      },
    },
  });

  registerTestCleanup(() => {
    manager.detachAll();
  });

  const onDetectSkipped = mock<(sessionID: SessionID) => void>();
  const recordNeedsInput = mock<(sessionID: SessionID, message: string) => void>();

  const detection = createScreenDetection({
    manager,
    clock,
    findRuntime: (id) => runtimes.get(id),
    recordNeedsInput,
    onDetectSkipped,
  });

  return {
    directory: temporaryDirectory.path,
    clock,
    provider,
    manager,
    runtimes,
    detection,
    onDetectSkipped,
    recordNeedsInput,
  };
}

test('it moves a session waiting at a prompt to needs_you once its output goes quiet', async () => {
  const ctx = await setupTest({
    adapters: [
      {
        ...buildStubHarnessAdapter(),
        screenDetector: {
          detectAttention: (screen) =>
            screen.trimEnd().endsWith('READY>') ? 'needs-input' : 'working',
          untilAgentStart: false,
        },
      },
    ],
  });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('READY>');
  ctx.clock.advance(300);

  await waitFor(() => {
    expect(session.state).toBe('needs_you');
  });

  expect(session.lastMsg).toBe('waiting at a prompt');
});

test('it records a needs-input event once for a wait the screen shows', async () => {
  const detectAttention = mock<(screen: string) => 'needs-input' | 'working' | null>(
    () => 'needs-input',
  );

  const ctx = await setupTest({
    adapters: [
      {
        ...buildStubHarnessAdapter(),
        screenDetector: { detectAttention, untilAgentStart: false },
      },
    ],
  });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('Allow the edit?');
  ctx.clock.advance(300);

  await waitFor(() => {
    expect(session.state).toBe('needs_you');
  });

  harness.emitData(' (y/n)');
  ctx.clock.advance(300);

  await waitFor(() => {
    expect(detectAttention).toHaveBeenCalledTimes(2);
  });

  expect(ctx.recordNeedsInput).toHaveBeenCalledExactlyOnceWith(session.id, 'waiting at a prompt');
});

test('it leaves the screen unjudged once the agent has started, for a detector that judges until the start', async () => {
  const ctx = await setupTest({
    adapters: [
      {
        ...buildStubHarnessAdapter(),
        screenDetector: { detectAttention: () => 'needs-input', untilAgentStart: true },
      },
    ],
  });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const runtime = ctx.runtimes.get(session.id);

  invariant(runtime);

  runtime.startedAt = ctx.clock.now();

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('Select a model');

  expect(ctx.clock.collectPending()).toBeEmpty();
});

test('it moves a session the screen flagged back to running when its agent starts', async () => {
  const ctx = await setupTest({
    adapters: [
      {
        ...buildStubHarnessAdapter(),
        screenDetector: { detectAttention: () => 'needs-input', untilAgentStart: true },
      },
    ],
  });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('Trust this folder?');
  ctx.clock.advance(300);

  await waitFor(() => {
    expect(session.state).toBe('needs_you');
  });

  ctx.detection.applyAgentStart(session.id);

  expect(session.state).toBe('running');
});

test('it leaves a needs_you the screen never set when the agent starts', async () => {
  const ctx = await setupTest({
    adapters: [
      {
        ...buildStubHarnessAdapter(),
        screenDetector: { detectAttention: () => 'working', untilAgentStart: true },
      },
    ],
  });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  ctx.manager.updateAttention(session.id, 'needs_you', 'Allow the edit?');
  ctx.detection.applyAgentStart(session.id);

  expect(session.state).toBe('needs_you');
});

test('it moves a session back to running once its screen shows work', async () => {
  const ctx = await setupTest({
    adapters: [
      {
        ...buildStubHarnessAdapter(),
        screenDetector: { detectAttention: () => 'working', untilAgentStart: false },
      },
    ],
  });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  ctx.manager.updateAttention(session.id, 'needs_you', 'Allow the edit?');

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('compiling');
  ctx.clock.advance(300);

  await waitFor(() => {
    expect(session.state).toBe('running');
  });
});

test('it restarts the wait on each output', async () => {
  const ctx = await setupTest({
    adapters: [
      {
        ...buildStubHarnessAdapter(),
        screenDetector: { detectAttention: () => 'working', untilAgentStart: false },
      },
    ],
  });

  await ctx.manager.spawn({ cwd: ctx.directory, name: 'worker', prompt: '', cols: 80, rows: 24 });

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

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('READY>');

  expect(ctx.onDetectSkipped).toHaveBeenCalledExactlyOnceWith(session.id);
  expect(ctx.clock.collectPending()).toBeEmpty();
});

test('it skips the screen of a session whose agent has no screen detector while another agent has one', async () => {
  const ctx = await setupTest({
    adapters: [
      buildStubHarnessAdapter(),
      {
        ...buildStubHarnessAdapter({ id: 'grok' }),
        screenDetector: { detectAttention: () => 'needs-input', untilAgentStart: false },
      },
    ],
  });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('READY>');

  expect(ctx.onDetectSkipped).toHaveBeenCalledExactlyOnceWith(session.id);
  expect(ctx.clock.collectPending()).toBeEmpty();
});
