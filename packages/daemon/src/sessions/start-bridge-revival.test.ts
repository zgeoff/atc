import { expect, test } from 'bun:test';
import { toSessionID } from '@atc/core';
import type { ExecutionProvider } from '@atc/plugin-api';
import type { HookEvent } from '@atc/protocol/session';
import { buildStubClock, registerTestCleanup, waitFor } from '@atc/test-utils';
import type { TapClient } from '../daemon-context';
import { buildMockSession } from '../testing/build-mock-session';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { createTapRegistry } from './create-tap-registry';
import type { Session } from './session';
import { startBridgeRevival } from './start-bridge-revival';

interface SetupTestConfig {
  // Whether the session's host is another machine.
  readonly remote: boolean;

  // How the host answers a transfer; it takes every transfer when absent.
  readonly transferArchive?: ExecutionProvider['transferArchive'];
}

function setupTest(config: SetupTestConfig) {
  const clock = buildStubClock(100_000);
  const taps = createTapRegistry<TapClient>();
  const sessions: Session[] = [];

  const ended = new Set<string>();

  const notes: HookEvent[] = [];
  const logs: string[] = [];

  const provider = buildStubMemoryProvider({
    kind: 'imp',
    remote: config.remote,
    guest: { directory: '/tmp/atc', atc: '/tmp/atc/bin/atc' },
    transferArchive: config.transferArchive ?? (() => Promise.resolve()),
  });

  const adapter = {
    ...buildStubHarnessAdapter({ takesMessages: true }),
    planGuestBridgeFiles: (atc: string) => ({
      'atc-bridge/hooks/atc-cli.ts': `export const ATC_CLI = ["${atc}"];\n`,
    }),
  };

  const revival = startBridgeRevival({
    manager: {
      sessions,
      findAdapter: () => adapter,
      requireExecution: () => ({ provider, identity: 'imp:test' }),
      log: (line) => {
        logs.push(line);
      },
    },
    taps,
    clock,
    isProcessEnded: (sessionID) => ended.has(sessionID),
    applyNote: (hookEvent) => {
      notes.push(hookEvent);

      return Promise.resolve();
    },
  });

  registerTestCleanup(() => {
    revival.stop();
  });

  const client: TapClient = { sendEvent: () => {} };

  return { clock, taps, sessions, ended, notes, logs, provider, client };
}

test('it writes the bridge mod of a running remote session whose tap stays gone for 30 s', () => {
  const ctx = setupTest({ remote: true });
  const id = toSessionID('s-bridge');

  const pty = ctx.provider.spawnHarness({
    session: id,
    host: id,
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  ctx.sessions.push(buildMockSession({ id, pty, state: 'running' }));
  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);
  ctx.clock.advance(30_000);

  expect(ctx.provider.transfers).toHaveLength(1);
  expect(ctx.provider.transfers[0]?.directory).toBe('/tmp/atc/sessions/s-bridge');
  expect(ctx.provider.transfers[0]?.host).toBe('s-bridge');

  expect(new TextDecoder().decode(ctx.provider.transfers[0]?.archive)).toInclude(
    'export const ATC_CLI = ["/tmp/atc/bin/atc"];',
  );
});

test('it records a note in the session events when it writes the mod again', async () => {
  const ctx = setupTest({ remote: true });
  const id = toSessionID('s-bridge');

  const pty = ctx.provider.spawnHarness({
    session: id,
    host: id,
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  ctx.sessions.push(buildMockSession({ id, pty, state: 'running' }));
  ctx.taps.attach(id, ctx.client);
  ctx.taps.detachAll(ctx.client);
  ctx.clock.advance(30_000);

  await waitFor(() => {
    expect(ctx.notes).toHaveLength(1);
  });

  expect(ctx.notes).toStrictEqual([
    {
      atcId: id,
      event: 'Note',
      payload: {
        kind: 'note',
        label: 'progress',
        text: 'atc: this session lost its atc-bridge tap, so its note and answer tools may be gone. atc wrote the bridge mod again, which makes Claude Code load it once more.',
      },
    },
  ]);
});

test('it writes nothing when a tap attaches again before the wait ends', () => {
  const ctx = setupTest({ remote: true });
  const id = toSessionID('s-bridge');

  const pty = ctx.provider.spawnHarness({
    session: id,
    host: id,
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  ctx.sessions.push(buildMockSession({ id, pty, state: 'running' }));
  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);
  ctx.clock.advance(10_000);
  ctx.taps.attach(id, ctx.client);
  ctx.clock.advance(20_000);

  expect(ctx.provider.transfers).toStrictEqual([]);
});

test('it logs each write in the daemon log', async () => {
  const ctx = setupTest({ remote: true });
  const id = toSessionID('s-bridge');

  const pty = ctx.provider.spawnHarness({
    session: id,
    host: id,
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  ctx.sessions.push(buildMockSession({ id, pty, state: 'running' }));
  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);
  ctx.clock.advance(30_000);

  await waitFor(() => {
    expect(ctx.logs).toStrictEqual([
      'session s-bridge: its atc-bridge tap was gone, so atc wrote the mod again',
    ]);
  });
});

test('it writes the mod once a session that slept through the wait wakes', () => {
  const ctx = setupTest({ remote: true });
  const id = toSessionID('s-bridge');

  const pty = ctx.provider.spawnHarness({
    session: id,
    host: id,
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  const session = buildMockSession({ id, pty, state: 'running' });

  ctx.sessions.push(session);
  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);

  // a suspend drops the terminal with the host's sleep
  session.pty = null;
  session.suspended = true;

  ctx.clock.advance(30_000);

  session.pty = pty;
  session.suspended = false;

  ctx.clock.advance(30_000);

  expect(ctx.provider.transfers).toHaveLength(1);
});

test('it logs a failed write, notes nothing, and writes again after a later tap loss', async () => {
  const ctx = setupTest({
    remote: true,
    transferArchive: () => Promise.reject(new Error('imp refused the transfer')),
  });

  const id = toSessionID('s-bridge');

  const pty = ctx.provider.spawnHarness({
    session: id,
    host: id,
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  ctx.sessions.push(buildMockSession({ id, pty, state: 'running' }));
  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);
  ctx.clock.advance(30_000);

  await waitFor(() => {
    expect(ctx.logs).toStrictEqual([
      'session s-bridge: writing its atc-bridge mod again failed: Error: imp refused the transfer',
    ]);
  });

  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);
  ctx.clock.advance(60_000);

  expect(ctx.provider.transfers).toHaveLength(2);
  expect(ctx.notes).toStrictEqual([]);
});

test('it writes nothing for a session on the daemon machine', () => {
  const ctx = setupTest({ remote: false });
  const id = toSessionID('s-bridge');

  const pty = ctx.provider.spawnHarness({
    session: id,
    host: id,
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  ctx.sessions.push(buildMockSession({ id, pty, state: 'running' }));
  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);
  ctx.clock.advance(30_000);

  expect(ctx.provider.transfers).toStrictEqual([]);
  expect(ctx.notes).toStrictEqual([]);
});

test('it waits at most 30 min between writes', async () => {
  const ctx = setupTest({ remote: true });
  const id = toSessionID('s-bridge');

  const pty = ctx.provider.spawnHarness({
    session: id,
    host: id,
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  ctx.sessions.push(buildMockSession({ id, pty, state: 'running' }));

  for (let loss = 1; loss <= 8; loss += 1) {
    ctx.taps.attach(id, ctx.client);
    ctx.taps.removeSession(id);
    ctx.clock.advance(30 * 60_000);

    // each write settles before the next loss
    await waitFor(() => {
      expect(ctx.notes).toHaveLength(loss);
    });
  }

  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);

  expect(ctx.clock.collectPending()).toStrictEqual([30 * 60_000]);
});

test('it waits 30 s from the latest tap loss', () => {
  const ctx = setupTest({ remote: true });
  const id = toSessionID('s-bridge');

  const pty = ctx.provider.spawnHarness({
    session: id,
    host: id,
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  ctx.sessions.push(buildMockSession({ id, pty, state: 'running' }));
  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);
  ctx.clock.advance(20_000);
  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);
  ctx.clock.advance(20_000);

  expect(ctx.provider.transfers).toStrictEqual([]);
  expect(ctx.clock.collectPending()).toStrictEqual([10_000]);
});

test('it writes nothing for a session whose agent process ended', () => {
  const ctx = setupTest({ remote: true });
  const id = toSessionID('s-bridge');

  const pty = ctx.provider.spawnHarness({
    session: id,
    host: id,
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  ctx.sessions.push(buildMockSession({ id, pty, state: 'running' }));
  ctx.ended.add(id);
  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);
  ctx.clock.advance(30_000);

  expect(ctx.provider.transfers).toStrictEqual([]);
});

test('it writes nothing for a session without a terminal', () => {
  const ctx = setupTest({ remote: true });
  const id = toSessionID('s-bridge');

  ctx.sessions.push(buildMockSession({ id, pty: null, state: 'exited' }));
  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);
  ctx.clock.advance(30_000);

  expect(ctx.provider.transfers).toStrictEqual([]);
});

test('it writes nothing and keeps waiting while the host sleeps', () => {
  const ctx = setupTest({ remote: true });
  const id = toSessionID('s-bridge');

  ctx.sessions.push(buildMockSession({ id, pty: null, state: 'running', suspended: true }));
  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);
  ctx.clock.advance(30_000);

  expect(ctx.provider.transfers).toStrictEqual([]);
  expect(ctx.clock.collectPending()).toStrictEqual([30_000]);
});

test('it doubles the wait after each write for a session that keeps losing its tap', async () => {
  const ctx = setupTest({ remote: true });
  const id = toSessionID('s-bridge');

  const pty = ctx.provider.spawnHarness({
    session: id,
    host: id,
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  ctx.sessions.push(buildMockSession({ id, pty, state: 'running' }));
  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);
  ctx.clock.advance(30_000);

  await waitFor(() => {
    expect(ctx.notes).toHaveLength(1);
  });

  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);
  ctx.clock.advance(60_000);

  await waitFor(() => {
    expect(ctx.notes).toHaveLength(2);
  });

  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);

  expect(ctx.clock.collectDelays()).toStrictEqual([30_000, 60_000, 120_000]);
});

test('it writes again after the doubled wait for a tap lost while a write was under way', async () => {
  const transfer = Promise.withResolvers<void>();
  const ctx = setupTest({ remote: true, transferArchive: () => transfer.promise });
  const id = toSessionID('s-bridge');

  const pty = ctx.provider.spawnHarness({
    session: id,
    host: id,
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  ctx.sessions.push(buildMockSession({ id, pty, state: 'running' }));
  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);
  ctx.clock.advance(30_000);
  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);
  transfer.resolve();

  await waitFor(() => {
    expect(ctx.notes).toHaveLength(1);
  });

  ctx.clock.advance(60_000);

  expect(ctx.provider.transfers).toHaveLength(2);
});

test('it makes one write per tap loss however long the tap stays gone', async () => {
  const ctx = setupTest({ remote: true });
  const id = toSessionID('s-bridge');

  const pty = ctx.provider.spawnHarness({
    session: id,
    host: id,
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  ctx.sessions.push(buildMockSession({ id, pty, state: 'running' }));
  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);
  ctx.clock.advance(30_000);

  await waitFor(() => {
    expect(ctx.notes).toHaveLength(1);
  });

  ctx.clock.advance(60 * 60_000);

  expect(ctx.provider.transfers).toHaveLength(1);
});
