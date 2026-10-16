import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { ansi, toSessionID } from '@atc/core';
import type { SessionID } from '@atc/core';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import { StateStore } from '@atc/store';
import { createMigratedStateDB } from '@atc/store/testing';
import { buildStubClock, registerTestCleanup, setupTempDir, waitFor } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import type { OutputClient } from '../daemon-context';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { ScreenModel } from './screen-model';
import { SessionOutput } from './session-output';
import { SessionRuntime } from './session-runtime';
import { SessionManager } from './sessions';

interface SetupTestConfig {
  // Whether the session's host can resize its terminal.
  readonly resize: boolean;
}

// A session manager on one `local` target over the in-memory provider, a
// real state store, and the output module over them; each session the
// manager announces gets the runtime the daemon gives it, and its screen
// once its terminal boots.
async function setupTest(config: SetupTestConfig) {
  const tmp = setupTempDir('atc-session-output-');
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const clock = buildStubClock(1_000_000);

  const runtimes = new Map<SessionID, SessionRuntime>();

  const provider = buildStubMemoryProvider({
    kind: 'local-pty',
    capabilities: { resize: config.resize },
  });

  const mgr = new SessionManager(
    null,
    store,
    join(tmp.dir, 'status.json'),
    [buildStubHarnessAdapter()],
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

        runtime?.resetBoot({ cols, rows });

        if (runtime !== undefined) {
          runtime.screen ??= new ScreenModel(cols, rows);
        }
      },
      onOutput: (s, data) => {
        output.recordOutput(s, data);
      },
    },
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  const emitted: EventMsg[] = [];
  const scheduleDetect = mock<(sessionID: SessionID) => void>();

  const output = new SessionOutput({
    mgr,
    clock,
    findRuntime: (id) => runtimes.get(id),
    emitEvent: (event) => {
      emitted.push(event);
    },
    findHookScope: () => null,
    scheduleDetect,
  });

  return { dir: tmp.dir, clock, provider, mgr, emitted, scheduleDetect, output };
}

test('it sends the output of a session to an attached client under the next sequence', async () => {
  const ctx = await setupTest({ resize: true });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const client = { sendOutput: mock<OutputClient['sendOutput']>() };

  ctx.output.attachSession(client, s.id, { cols: 80, rows: 24 });

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('build finished');

  expect(client.sendOutput).toHaveBeenLastCalledWith(
    s.id,
    { v: PROTOCOL_V, ev: 'SessionOutput', s: s.id, seq: 1, d: 'build finished' },
    14,
  );
});

test('it starts the wait before the screen is judged on each output', async () => {
  const ctx = await setupTest({ resize: true });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('compiling');

  expect(ctx.scheduleDetect).toHaveBeenCalledExactlyOnceWith(s.id);
});

test('it replays the screen to an attaching client after a clear', async () => {
  const ctx = await setupTest({ resize: true });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('tests passed');

  const sent: string[] = [];

  const client = {
    sendOutput: (_sessionID: SessionID, event: EventMsg) => {
      sent.push(String(event['d']));
    },
  };

  ctx.output.attachSession(client, s.id, { cols: 80, rows: 24 });

  await waitFor(() => {
    expect(sent.join('')).toStartWith(ansi.clear);
    expect(sent.join('')).toInclude('tests passed');
  });
});

test('it announces an attach with the session it attached', async () => {
  const ctx = await setupTest({ resize: true });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const attached = ctx.output.attachSession(
    { sendOutput: mock<OutputClient['sendOutput']>() },
    s.id,
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
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitExit({ exitCode: 1 });

  await waitFor(() => {
    expect(ctx.mgr.sessions.find((x) => x.id === s.id)?.pty).toBeNull();
  });

  const attached = ctx.output.attachSession(
    { sendOutput: mock<OutputClient['sendOutput']>() },
    s.id,
    { cols: 80, rows: 24 },
  );

  expect(attached).toBe('dead');
});

test('it sizes the terminal to the smallest size across its attached clients', async () => {
  const ctx = await setupTest({ resize: true });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  ctx.output.attachSession({ sendOutput: mock<OutputClient['sendOutput']>() }, s.id, {
    cols: 120,
    rows: 30,
  });

  ctx.output.attachSession({ sendOutput: mock<OutputClient['sendOutput']>() }, s.id, {
    cols: 100,
    rows: 40,
  });

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  expect(harness.sizes).toStrictEqual([
    [120, 30],
    [100, 30],
  ]);

  expect(ctx.output.getEffectiveDims(s.id)).toStrictEqual({ cols: 100, rows: 30 });
});

test('it applies a client resize once the wait for more has passed', async () => {
  const ctx = await setupTest({ resize: true });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const client = { sendOutput: mock<OutputClient['sendOutput']>() };

  ctx.output.attachSession(client, s.id, { cols: 120, rows: 30 });

  const resized = ctx.output.updateSessionDims(client, s.id, { cols: 90, rows: 20 });

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
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const resized = ctx.output.updateSessionDims(
    { sendOutput: mock<OutputClient['sendOutput']>() },
    s.id,
    { cols: 90, rows: 20 },
  );

  expect(resized).toBeFalse();
});

test('it keeps the terminal size on a host that cannot resize and still announces the size', async () => {
  const ctx = await setupTest({ resize: false });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  ctx.output.attachSession({ sendOutput: mock<OutputClient['sendOutput']>() }, s.id, {
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
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 132, 43);

  expect(ctx.output.getEffectiveDims(s.id)).toStrictEqual({ cols: 132, rows: 43 });
});

test('it reads 80 by 24 for a session with no size', async () => {
  const ctx = await setupTest({ resize: true });

  expect(ctx.output.getEffectiveDims(toSessionID('s-gone'))).toStrictEqual({ cols: 80, rows: 24 });
});

test('it announces a detach and sends the client no more output', async () => {
  const ctx = await setupTest({ resize: true });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const client = { sendOutput: mock<OutputClient['sendOutput']>() };

  ctx.output.attachSession(client, s.id, { cols: 80, rows: 24 });
  ctx.output.detachSession(client, s.id);
  client.sendOutput.mockClear();

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('more output');

  expect(ctx.emitted).toPartiallyContain({ ev: 'SessionDetached' });
  expect(client.sendOutput).not.toHaveBeenCalled();
});

test('it detaches a leaving client from every session it attached', async () => {
  const ctx = await setupTest({ resize: true });
  const one = await ctx.mgr.spawn(ctx.dir, 'one', '', 80, 24);
  const two = await ctx.mgr.spawn(ctx.dir, 'two', '', 80, 24);

  const client = { sendOutput: mock<OutputClient['sendOutput']>() };

  ctx.output.attachSession(client, one.id, { cols: 80, rows: 24 });
  ctx.output.attachSession(client, two.id, { cols: 80, rows: 24 });
  ctx.output.detachClient(client);

  const detached = ctx.emitted.filter((event) => event.ev === 'SessionDetached');

  expect(detached).toHaveLength(2);
});

test('it sends a removed session no more output to its clients', async () => {
  const ctx = await setupTest({ resize: true });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const client = { sendOutput: mock<OutputClient['sendOutput']>() };

  ctx.output.attachSession(client, s.id, { cols: 80, rows: 24 });
  ctx.output.removeSession(s.id);
  client.sendOutput.mockClear();

  const [harness] = ctx.provider.harnesses;

  invariant(harness);

  harness.emitData('late output');

  expect(client.sendOutput).not.toHaveBeenCalled();
});
