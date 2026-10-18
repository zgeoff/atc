import { expect, test } from 'bun:test';
import { toSessionID } from '@atc/core';
import type { HookEvent } from '@atc/protocol/session';
import { buildStubClock, registerTestCleanup, waitFor } from '@atc/test-utils';
import type { TapClient } from '../daemon-context';
import { buildMockSession } from '../testing/build-mock-session';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import type { Session } from './session';
import { startBridgeRevival } from './start-bridge-revival';
import { TapRegistry } from './tap-registry';

function setupTest() {
  const clock = buildStubClock(100_000);

  const taps = new TapRegistry<TapClient>();

  const sessions: Session[] = [];

  const ended = new Set<string>();

  const notes: HookEvent[] = [];
  const logs: string[] = [];

  const provider = buildStubMemoryProvider({
    kind: 'imp',
    remote: true,
    guest: { dir: '/tmp/atc', atc: '/tmp/atc/bin/atc' },
  });

  const adapter = {
    ...buildStubHarnessAdapter({ takesMessages: true }),
    planGuestBridgeFiles: (atc: string) => ({
      'atc-bridge/hooks/atc-cli.ts': `export const ATC_CLI = ["${atc}"];\n`,
    }),
  };

  const revival = startBridgeRevival({
    mgr: {
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
    applyNote: (e) => {
      notes.push(e);

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
  const ctx = setupTest();
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
  expect(ctx.provider.transfers[0]?.dir).toBe('/tmp/atc/sessions/s-bridge');
  expect(ctx.provider.transfers[0]?.host).toBe('s-bridge');

  expect(new TextDecoder().decode(ctx.provider.transfers[0]?.archive)).toInclude(
    'export const ATC_CLI = ["/tmp/atc/bin/atc"];',
  );
});

test('it records a note in the session events when it writes the mod again', async () => {
  const ctx = setupTest();
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
  const ctx = setupTest();
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
  const ctx = setupTest();
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

test('it waits 30 s from the latest tap loss', () => {
  const ctx = setupTest();
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
  const ctx = setupTest();
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
  const ctx = setupTest();
  const id = toSessionID('s-bridge');

  ctx.sessions.push(buildMockSession({ id, pty: null, state: 'exited' }));
  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);
  ctx.clock.advance(30_000);

  expect(ctx.provider.transfers).toStrictEqual([]);
});

test('it writes nothing for a session whose host sleeps', () => {
  const ctx = setupTest();
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

  ctx.sessions.push(buildMockSession({ id, pty, state: 'running', suspended: true }));
  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);
  ctx.clock.advance(30_000);

  expect(ctx.provider.transfers).toStrictEqual([]);
});

test('it doubles the wait after each write for a session that keeps losing its tap', () => {
  const ctx = setupTest();
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
  ctx.clock.advance(60_000);
  ctx.taps.attach(id, ctx.client);
  ctx.taps.removeSession(id);

  expect(ctx.clock.collectDelays()).toStrictEqual([30_000, 60_000, 120_000]);
});

test('it makes one write per tap loss however long the tap stays gone', () => {
  const ctx = setupTest();
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
  ctx.clock.advance(60 * 60_000);

  expect(ctx.provider.transfers).toHaveLength(1);
});
