import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toAgentSessionID } from '@atc/core';
import { startDaemon } from '@atc/daemon';
import { findDaemonRecord } from '@atc/lifecycle';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { StateStore } from '@atc/store';
import { buildMockFleetEntry } from '@atc/store/testing';
import {
  KEYS,
  buildMockAgentAdapter,
  buildStubHeldZoxide,
  createStubBin,
  registerTestCleanup,
  startTUIHarness,
  waitFor,
} from '@atc/test-utils';
import { buildHostServices } from '../packages/app/src/build-host-services';
import { buildLocalTarget } from '../packages/app/src/test-utils/build-local-target';

function setupTest() {
  return startTUIHarness();
}

test('it restarts a daemon on another protocol after the user confirms and restores the fleet', async () => {
  const ctx = setupTest();
  const stateDir = join(ctx.home, '.local', 'state', 'atc');
  const socketPath = join(ctx.home, 'atc-daemon.sock');

  // The fleet a daemon that already ran here left behind: one resumable
  // Claude session in the home.
  mkdirSync(stateDir, { recursive: true });

  const seed = await StateStore.open(join(stateDir, 'atc.db'));

  registerTestCleanup(() => seed.stop());

  await seed.writeFleet([
    buildMockFleetEntry({
      name: 'fleettest',
      cwd: ctx.home,
      agentSessionID: toAgentSessionID('fake-1'),
    }),
  ]);

  await seed.stop();

  // A daemon on another protocol takes the socket and records its pid, as
  // a daemon from another release would.
  const legacy = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'packages', 'test-utils', 'src', 'run-stub-legacy-daemon.ts'),
      socketPath,
      stateDir,
    ],
    { stdout: 'pipe', stderr: 'inherit' },
  );

  registerTestCleanup(() => {
    legacy.kill('SIGKILL');
  });

  const reader = legacy.stdout.getReader();

  await reader.read();

  reader.releaseLock();
  ctx.reset();
  ctx.boot();

  await ctx.waitFor('Restart it now?');

  expect(ctx.read()).toInclude(`daemon atc/legacy-build speaks v${PROTOCOL_V + 1}`);

  ctx.reset();
  ctx.write('y');

  await ctx.waitFor('fleettest');

  await legacy.exited;

  expect(legacy.signalCode).toBe('SIGTERM');
});

test('it restarts a daemon on another protocol that a reconnect meets after the user confirms', async () => {
  const reconnect = await setupReconnectTest();

  const ctx = reconnect.ctx;
  const legacy = reconnect.legacy;

  await ctx.waitFor('Restart it now?');

  expect(ctx.read()).toInclude(`daemon atc/legacy-build speaks v${PROTOCOL_V + 1}`);

  ctx.reset();
  ctx.write('y');

  await legacy.exited;

  await ctx.waitFor('idle');

  expect(legacy.signalCode).toBe('SIGTERM');
});

test('it draws the reconnect restart prompt again when the terminal resizes', async () => {
  const reconnect = await setupReconnectTest();

  const ctx = reconnect.ctx;
  const legacy = reconnect.legacy;

  await ctx.waitFor('Restart it now?');

  ctx.reset();
  reconnect.pty.resize(100, 30);

  await ctx.waitFor('Restart it now?');

  ctx.write('y');

  await legacy.exited;

  expect(legacy.signalCode).toBe('SIGTERM');
});

test('it keeps the reconnect restart prompt on screen when a directory listing answers late', async () => {
  const ctx = setupTest();
  const stateDir = join(ctx.home, '.local', 'state', 'atc');
  const socketPath = join(ctx.home, 'atc-daemon.sock');

  mkdirSync(stateDir, { recursive: true });

  // While the hold file exists, the client's own zoxide marks that it
  // started and waits, so the picker's local directory listing answers
  // only once the test removes the file.
  createStubBin(join(ctx.home, 'bin'), 'zoxide', buildStubHeldZoxide());
  writeFileSync(join(ctx.home, 'zoxide-hold'), '');

  // A daemon of an older build on this protocol offers no sources, so the
  // picker lists directories on the client's host.
  const older = await startStubDaemonProcess(socketPath, stateDir, 'current');

  ctx.boot();

  await ctx.waitFor('update ready');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.write(KEYS.enter);

  await waitFor(() => {
    expect(existsSync(join(ctx.home, 'zoxide-held'))).toBe(true);
  });

  unlinkSync(socketPath);

  const legacy = await startStubDaemonProcess(socketPath, stateDir);

  older.kill('SIGTERM');

  await ctx.waitFor('Restart it now?');

  ctx.reset();

  const mark = ctx.countClientLogLines();

  rmSync(join(ctx.home, 'zoxide-hold'));

  await ctx.waitForClientLog('dropped local directory listing answer', mark);

  expect(ctx.read()).not.toInclude('spawn:');

  ctx.write('n');

  const code = await ctx.waitForExit();

  expect(code).toBe(1);
  expect(legacy.exitCode).toBeNull();
});

test('it quits when the user keeps a daemon on another protocol that a reconnect meets', async () => {
  const reconnect = await setupReconnectTest();

  const ctx = reconnect.ctx;
  const legacy = reconnect.legacy;

  await ctx.waitFor('Restart it now?');

  ctx.reset();
  ctx.write('n');

  const code = await ctx.waitForExit();

  expect(code).toBe(1);
  expect(ctx.read()).toInclude(`daemon atc/legacy-build speaks v${PROTOCOL_V + 1}`);
  expect(legacy.exitCode).toBeNull();
});

test('it draws help again when the user confirms a restart that a reconnect meets with help open', async () => {
  const managed = await setupManagedReconnectTest();

  const ctx = managed.ctx;

  ctx.write('?');

  await ctx.waitFor('attach the selected session');

  const legacy = await managed.startLegacyDaemon();

  await ctx.waitFor('Restart it now?');

  ctx.reset();
  ctx.write('y');

  await legacy.exited;

  await ctx.waitFor('attach the selected session');

  expect(legacy.signalCode).toBe('SIGTERM');
});

test('it draws the home screen again when the user confirms a restart that a reconnect meets at home', async () => {
  const managed = await setupManagedReconnectTest();

  const ctx = managed.ctx;

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor('control tower for coding-agent sessions');

  const legacy = await managed.startLegacyDaemon();

  await ctx.waitFor('Restart it now?');

  ctx.reset();
  ctx.write('y');

  await legacy.exited;

  await ctx.waitFor('control tower for coding-agent sessions');

  expect(legacy.signalCode).toBe('SIGTERM');
});

test('it draws the spawn picker again when the user confirms a restart that a reconnect meets in the picker', async () => {
  const managed = await setupManagedReconnectTest();

  const ctx = managed.ctx;

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor('control tower for coding-agent sessions');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  const legacy = await managed.startLegacyDaemon();

  await ctx.waitFor('Restart it now?');

  ctx.reset();
  ctx.write('y');

  await legacy.exited;

  await ctx.waitFor('spawn: agent');

  expect(legacy.signalCode).toBe('SIGTERM');
});

test('it stops a daemon of an older build when the user asks for the update and boots its own build', async () => {
  const ctx = setupTest();
  const stateDir = join(ctx.home, '.local', 'state', 'atc');
  const socketPath = join(ctx.home, 'atc-daemon.sock');

  mkdirSync(stateDir, { recursive: true });

  // A daemon of an older build on this protocol takes the socket and
  // records its pid. It answers no quit request, so only a stop from
  // outside ends it.
  const older = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'packages', 'test-utils', 'src', 'run-stub-legacy-daemon.ts'),
      socketPath,
      stateDir,
      'current',
    ],
    { stdout: 'pipe', stderr: 'inherit' },
  );

  registerTestCleanup(() => {
    older.kill('SIGKILL');
  });

  const reader = older.stdout.getReader();

  await reader.read();

  reader.releaseLock();
  ctx.boot();

  await ctx.waitFor('update ready');

  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('u update daemon');

  ctx.reset();
  ctx.write('u');

  await ctx.waitFor('restarting daemon');

  await older.exited;

  await ctx.waitFor('idle');

  // The status bar is drawn on a timer, so one the menu scheduled can still
  // draw the stale mark after the reset; only what follows the restart's
  // own status bar counts.
  const screen = ctx.read();

  expect(older.signalCode).toBe('SIGTERM');
  expect(screen.slice(screen.lastIndexOf('restarting daemon'))).not.toInclude('update ready');
});

/**
 * Boots the client on a daemon of its own, then hands the socket path to a
 * daemon on another protocol and kills the first daemon, so the client's
 * reconnect reaches the other one. Returns the harness, that daemon's
 * process, and the client's terminal.
 */
async function setupReconnectTest() {
  const ctx = setupTest();
  const stateDir = join(ctx.home, '.local', 'state', 'atc');
  const socketPath = join(ctx.home, 'atc-daemon.sock');
  const pty = ctx.boot();

  await ctx.waitFor('idle');

  const first = findDaemonRecord(join(stateDir, 'daemon.json'));

  if (first === null) {
    throw new Error('the first daemon wrote no record');
  }

  // The first daemon keeps its listener and the client's connection after
  // its socket file goes, so the other daemon can bind the path.
  unlinkSync(socketPath);

  const legacy = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'packages', 'test-utils', 'src', 'run-stub-legacy-daemon.ts'),
      socketPath,
      stateDir,
    ],
    { stdout: 'pipe', stderr: 'inherit' },
  );

  registerTestCleanup(() => {
    legacy.kill('SIGKILL');
  });

  const reader = legacy.stdout.getReader();

  await reader.read();

  reader.releaseLock();
  ctx.reset();
  process.kill(first.pid, 'SIGKILL');

  return { ctx, legacy, pty };
}

/**
 * Boots the client on a daemon that a user unit manages, then stops that
 * daemon, so the client waits for it to return without starting one.
 * Returns the harness and a starter for a daemon on another protocol on
 * the same socket, which the waiting client reaches next.
 */
async function setupManagedReconnectTest() {
  const ctx = setupTest();
  const stateDir = join(ctx.home, '.local', 'state', 'atc');
  const socketPath = join(ctx.home, 'atc-daemon.sock');
  const unitDir = join(ctx.home, '.config', 'systemd', 'user');

  mkdirSync(stateDir, { recursive: true });
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, 'atc-daemon.service'), '[Service]\nExecStart=atc daemon\n');

  const first = await startDaemon({
    socketPath,
    reporterSocketPath: join(ctx.home, 'atc.sock'),
    dbPath: join(stateDir, 'atc.db'),
    statusPath: join(stateDir, 'status.json'),
    build: buildHostServices().build,
    targets: [buildLocalTarget()],
    adapter: buildMockAgentAdapter(),
  });

  registerTestCleanup(() => first.stop());

  ctx.boot();

  await ctx.waitFor('no session');

  ctx.reset();

  await first.stop();
  await ctx.waitFor('waiting for daemon');

  return {
    ctx,
    startLegacyDaemon: () => startStubDaemonProcess(socketPath, stateDir),
  };
}

/**
 * Starts a stand-in daemon as its own process on the socket path, recorded
 * in the state directory, and waits until it listens. It speaks another
 * protocol, or this one as an older build when `build` is `current`. It is
 * killed once the test finishes.
 */
async function startStubDaemonProcess(socketPath: string, stateDir: string, build?: 'current') {
  const daemon = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'packages', 'test-utils', 'src', 'run-stub-legacy-daemon.ts'),
      socketPath,
      stateDir,
      ...(build === undefined ? [] : [build]),
    ],
    { stdout: 'pipe', stderr: 'inherit' },
  );

  registerTestCleanup(() => {
    daemon.kill('SIGKILL');
  });

  const reader = daemon.stdout.getReader();

  await reader.read();

  reader.releaseLock();

  return daemon;
}
