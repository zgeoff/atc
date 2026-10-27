import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { ansi } from '@atc/core';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import { createStateStore } from '@atc/store';
import {
  buildStubClock,
  createMigratedStateDB,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import type { SessionID } from '@atcx/contract';
import invariant from 'tiny-invariant';
import type { OutputClient } from '../daemon-context';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubLateOutputScreen } from '../testing/build-stub-late-output-screen';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { createScreenModel } from './create-screen-model';
import { createSessionManager } from './create-session-manager';
import { createSessionOutput } from './create-session-output';
import { createSessionRuntime } from './create-session-runtime';
import type { SessionRuntime } from './create-session-runtime';

interface SetupTestConfig {
  // Whether the session's host can resize its terminal.
  readonly resize: boolean;
}

async function setupTest(config: SetupTestConfig) {
  const temporaryDirectory = setupTempDir('atc-session-output-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const clock = buildStubClock(1_000_000);

  const runtimes = new Map<SessionID, SessionRuntime>();

  const provider = buildStubMemoryProvider({
    kind: 'local-pty',
    capabilities: { resize: config.resize },
  });

  const manager = createSessionManager({
    fallback: null,
    store,
    statusPath: join(temporaryDirectory.path, 'status.json'),
    adapters: [buildStubHarnessAdapter()],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
    events: {
      onEvent: (kind, session) => {
        if (kind === 'added') {
          runtimes.set(session.id, createSessionRuntime());
        }
      },
      onBoot: (session, cols, rows) => {
        const runtime = runtimes.get(session.id);

        runtime?.resetBoot({ cols, rows });

        if (runtime !== undefined) {
          runtime.screen ??= createScreenModel(cols, rows);
        }
      },
      onOutput: (session, data) => {
        output.recordOutput(session, data);
      },
    },
  });

  registerTestCleanup(() => {
    manager.detachAll();
  });

  const emitted: EventMsg[] = [];
  const scheduleDetect = mock<(sessionID: SessionID) => void>();

  const output = createSessionOutput({
    manager,
    clock,
    findRuntime: (id) => runtimes.get(id),
    emitEvent: (event) => {
      emitted.push(event);
    },
    findHookScope: () => null,
    scheduleDetect,
  });

  return {
    directory: temporaryDirectory.path,
    clock,
    provider,
    manager,
    runtimes,
    emitted,
    scheduleDetect,
    output,
  };
}

test('it sends the output of a session to an attached client under the next sequence', async () => {
  const ctx = await setupTest({ resize: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const client = { sendOutput: mock<OutputClient['sendOutput']>() };

  ctx.output.attachSession(client, session.id, { cols: 80, rows: 24 });

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('build finished');

  expect(client.sendOutput).toHaveBeenLastCalledWith(
    session.id,
    {
      version: PROTOCOL_V,
      ev: 'SessionOutput',
      sessionID: session.id,
      seq: 1,
      data: 'build finished',
    },
    14,
  );
});

test('it starts the wait before the screen is judged on each output', async () => {
  const ctx = await setupTest({ resize: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('compiling');

  expect(ctx.scheduleDetect).toHaveBeenCalledExactlyOnceWith(session.id);
});

test('it replays the screen to an attaching client after a clear', async () => {
  const ctx = await setupTest({ resize: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('tests passed');

  const sent: string[] = [];

  const client = {
    sendOutput: (_sessionID: SessionID, event: EventMsg) => {
      sent.push(String(event['data']));
    },
  };

  ctx.output.attachSession(client, session.id, { cols: 80, rows: 24 });

  await waitFor(() => {
    expect(sent.join('')).toStartWith(ansi.clear);
    expect(sent.join('')).toInclude('tests passed');
  });
});

test('it announces an attach with the session it attached', async () => {
  const ctx = await setupTest({ resize: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const attached = ctx.output.attachSession(
    { sendOutput: mock<OutputClient['sendOutput']>() },
    session.id,
    { cols: 80, rows: 24 },
  );

  expect(attached).toBe('ok');
  expect(ctx.emitted).toPartiallyContain({ ev: 'SessionAttached' });
});

test('it refuses to attach a session the manager does not hold', async () => {
  const ctx = await setupTest({ resize: true });

  const attached = ctx.output.attachSession(
    { sendOutput: mock<OutputClient['sendOutput']>() },
    toSessionID('s-gone'),
    { cols: 80, rows: 24 },
  );

  expect(attached).toBe('missing');
});

test('it refuses to attach a session whose terminal has ended', async () => {
  const ctx = await setupTest({ resize: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitExit({ exitCode: 1 });

  await waitFor(() => {
    expect(ctx.manager.sessions.find((x) => x.id === session.id)?.pty).toBeNull();
  });

  const attached = ctx.output.attachSession(
    { sendOutput: mock<OutputClient['sendOutput']>() },
    session.id,
    { cols: 80, rows: 24 },
  );

  expect(attached).toBe('dead');
});

test('it sizes the terminal to the smallest size across its attached clients', async () => {
  const ctx = await setupTest({ resize: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  ctx.output.attachSession({ sendOutput: mock<OutputClient['sendOutput']>() }, session.id, {
    cols: 120,
    rows: 30,
  });

  ctx.output.attachSession({ sendOutput: mock<OutputClient['sendOutput']>() }, session.id, {
    cols: 100,
    rows: 40,
  });

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  expect(harness.sizes).toStrictEqual([
    [120, 30],
    [100, 30],
  ]);

  expect(ctx.output.getEffectiveDims(session.id)).toStrictEqual({ cols: 100, rows: 30 });
});

test('it applies a client resize once the wait for more has passed', async () => {
  const ctx = await setupTest({ resize: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const client = { sendOutput: mock<OutputClient['sendOutput']>() };

  ctx.output.attachSession(client, session.id, { cols: 120, rows: 30 });

  const resized = ctx.output.updateSessionDims(client, session.id, { cols: 90, rows: 20 });

  ctx.clock.advance(50);

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  expect(resized).toBeTrue();

  expect(harness.sizes).toStrictEqual([
    [120, 30],
    [90, 20],
  ]);
});

test('it refuses a resize from a client that is not attached', async () => {
  const ctx = await setupTest({ resize: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const resized = ctx.output.updateSessionDims(
    { sendOutput: mock<OutputClient['sendOutput']>() },
    session.id,
    { cols: 90, rows: 20 },
  );

  expect(resized).toBeFalse();
});

test('it keeps the terminal size on a host that cannot resize and still announces the size', async () => {
  const ctx = await setupTest({ resize: false });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  ctx.output.attachSession({ sendOutput: mock<OutputClient['sendOutput']>() }, session.id, {
    cols: 120,
    rows: 30,
  });

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  expect(harness.sizes).toBeEmpty();
  expect(ctx.emitted).toPartiallyContain({ ev: 'SessionResized', cols: 120, rows: 30 });
});

test('it reads the size the terminal booted at when no client is attached', async () => {
  const ctx = await setupTest({ resize: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 132,
    rows: 43,
  });

  expect(ctx.output.getEffectiveDims(session.id)).toStrictEqual({ cols: 132, rows: 43 });
});

test('it reads 80 by 24 for a session with no size', async () => {
  const ctx = await setupTest({ resize: true });

  expect(ctx.output.getEffectiveDims(toSessionID('s-gone'))).toStrictEqual({ cols: 80, rows: 24 });
});

test('it announces a detach and sends the client no more output', async () => {
  const ctx = await setupTest({ resize: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const client = { sendOutput: mock<OutputClient['sendOutput']>() };

  ctx.output.attachSession(client, session.id, { cols: 80, rows: 24 });
  ctx.output.detachSession(client, session.id);
  client.sendOutput.mockClear();

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('more output');

  expect(ctx.emitted).toPartiallyContain({ ev: 'SessionDetached' });
  expect(client.sendOutput).not.toHaveBeenCalled();
});

test('it detaches a leaving client from every session it attached', async () => {
  const ctx = await setupTest({ resize: true });

  const one = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'one',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const two = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'two',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const client = { sendOutput: mock<OutputClient['sendOutput']>() };

  ctx.output.attachSession(client, one.id, { cols: 80, rows: 24 });
  ctx.output.attachSession(client, two.id, { cols: 80, rows: 24 });
  ctx.output.detachClient(client);

  const detached = ctx.emitted.filter((event) => event.ev === 'SessionDetached');

  expect(detached).toHaveLength(2);
});

test('it sends a removed session no more output to its clients', async () => {
  const ctx = await setupTest({ resize: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const client = { sendOutput: mock<OutputClient['sendOutput']>() };

  ctx.output.attachSession(client, session.id, { cols: 80, rows: 24 });
  ctx.output.removeSession(session.id);
  client.sendOutput.mockClear();

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('late output');

  expect(client.sendOutput).not.toHaveBeenCalled();
});

test('it starts a watcher with the replayed screen and the last sequence it holds', async () => {
  const ctx = await setupTest({ resize: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  ctx.output.attachSession({ sendOutput: mock<OutputClient['sendOutput']>() }, session.id, {
    cols: 80,
    rows: 24,
  });

  harness.emitData('tests passed');

  const watch = await ctx.output.watchSession(
    { sendOutput: mock<OutputClient['sendOutput']>() },
    session.id,
  );

  invariant(typeof watch === 'object');

  expect(watch).toStrictEqual({
    cols: 80,
    rows: 24,
    seq: 1,
    replay: expect.toStartWith(ansi.clear),
  });

  expect(watch.replay).toInclude('tests passed');
});

test('it answers a watch with the size the replay is laid out at while a resize waits to apply', async () => {
  const ctx = await setupTest({ resize: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const client = { sendOutput: mock<OutputClient['sendOutput']>() };

  ctx.output.attachSession(client, session.id, { cols: 80, rows: 24 });
  ctx.output.updateSessionDims(client, session.id, { cols: 40, rows: 12 });

  const watch = await ctx.output.watchSession(
    { sendOutput: mock<OutputClient['sendOutput']>() },
    session.id,
  );

  expect(watch).toMatchObject({ cols: 80, rows: 24 });
});

test('it sends a watcher the output that follows its start under the next sequence', async () => {
  const ctx = await setupTest({ resize: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  const watcher = { sendOutput: mock<OutputClient['sendOutput']>() };

  await ctx.output.watchSession(watcher, session.id);

  harness.emitData('build finished');

  expect(watcher.sendOutput).toHaveBeenCalledExactlyOnceWith(
    session.id,
    {
      version: PROTOCOL_V,
      ev: 'SessionOutput',
      sessionID: session.id,
      seq: 1,
      data: 'build finished',
    },
    14,
  );
});

test('it starts a watcher on a session in the alternate buffer with the normal buffer under it', async () => {
  const ctx = await setupTest({ resize: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('shell prompt\r\n\u001B[?1049hfullscreen app');

  const watch = await ctx.output.watchSession(
    { sendOutput: mock<OutputClient['sendOutput']>() },
    session.id,
  );

  invariant(typeof watch === 'object');

  expect(watch.replay.indexOf('shell prompt')).toBeGreaterThan(-1);

  expect(watch.replay.indexOf('\u001B[?1049h')).toBeGreaterThan(
    watch.replay.indexOf('shell prompt'),
  );
});

test('it shows a watcher each output printed while its replay is captured exactly once', async () => {
  const ctx = await setupTest({ resize: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  const watcher = { sendOutput: mock<OutputClient['sendOutput']>() };

  harness.emitData('alpha\r\n');

  const runtime = ctx.runtimes.get(session.id);

  invariant(runtime?.screen);

  runtime.screen = buildStubLateOutputScreen(runtime.screen, () => {
    harness.emitData('charlie\r\n');
  });

  const watching = ctx.output.watchSession(watcher, session.id);

  harness.emitData('bravo\r\n');

  const watch = await watching;

  invariant(typeof watch === 'object');

  harness.emitData('delta\r\n');

  const live = watcher.sendOutput.mock.calls.flatMap(([, event]) => {
    const seq = event['seq'];
    const data = event['data'];

    return typeof seq === 'number' && seq > watch.seq && typeof data === 'string' ? [data] : [];
  });

  const shown = `${watch.replay}${live.join('')}`;

  expect(
    ['alpha', 'bravo', 'charlie', 'delta'].map((word) => shown.split(word).length - 1),
  ).toStrictEqual([1, 1, 1, 1]);
});

test('it leaves the terminal size and the attach record alone when a watcher comes and goes', async () => {
  const ctx = await setupTest({ resize: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  ctx.output.attachSession({ sendOutput: mock<OutputClient['sendOutput']>() }, session.id, {
    cols: 120,
    rows: 30,
  });

  const before = ctx.manager.sessions.find((x) => x.id === session.id);

  invariant(before);

  const lastAttachedAt = before.lastAttachedAt;
  const events = ctx.emitted.length;
  const watcher = { sendOutput: mock<OutputClient['sendOutput']>() };

  await ctx.output.watchSession(watcher, session.id);

  ctx.output.detachClient(watcher);
  ctx.clock.advance(50);

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  expect(harness.sizes).toStrictEqual([[120, 30]]);
  expect(ctx.output.getEffectiveDims(session.id)).toStrictEqual({ cols: 120, rows: 30 });
  expect(before.lastAttachedAt).toBe(lastAttachedAt);
  expect(ctx.emitted).toHaveLength(events);
});

test('it sends a detached watcher no more output', async () => {
  const ctx = await setupTest({ resize: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const watcher = { sendOutput: mock<OutputClient['sendOutput']>() };

  await ctx.output.watchSession(watcher, session.id);

  ctx.output.detachSession(watcher, session.id);

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('late output');

  expect(watcher.sendOutput).not.toHaveBeenCalled();
});

test('it sends a watcher no replay as output when its dropped output is repaired', async () => {
  const ctx = await setupTest({ resize: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const watcher = { sendOutput: mock<OutputClient['sendOutput']>() };

  await ctx.output.watchSession(watcher, session.id);
  await ctx.output.sendReplay(session.id, watcher);

  expect(watcher.sendOutput).not.toHaveBeenCalled();
});

test('it refuses to watch a session the manager does not hold', async () => {
  const ctx = await setupTest({ resize: true });

  const watch = await ctx.output.watchSession(
    { sendOutput: mock<OutputClient['sendOutput']>() },
    toSessionID('s-gone'),
  );

  expect(watch).toBe('missing');
});

test('it refuses to watch a session whose terminal has ended', async () => {
  const ctx = await setupTest({ resize: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitExit({ exitCode: 1 });

  await waitFor(() => {
    expect(ctx.manager.sessions.find((x) => x.id === session.id)?.pty).toBeNull();
  });

  const watch = await ctx.output.watchSession(
    { sendOutput: mock<OutputClient['sendOutput']>() },
    session.id,
  );

  expect(watch).toBe('dead');
});
