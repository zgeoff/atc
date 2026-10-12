import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findDaemonRecord } from '../shared/find-daemon-record';
import { isProcessAlive } from '../shared/is-process-alive';
import { buildStubHandoffDaemon } from './build-stub-handoff-daemon';
import { createStubBin } from './create-stub-bin';
import { registerTestCleanup } from './register-test-cleanup';
import { resolveATCCommand } from './resolve-atc-command';
import { setupTempDir } from './setup-temp-dir';
import { startDaemonProcess } from './start-daemon-process';
import { waitFor } from './wait-for';

/**
 * A fresh home for one daemon process; a daemon that finds no config there
 * writes its own on first run.
 */
function setupTest() {
  const tmp = setupTempDir('atc-daemon-process-');

  return { dir: tmp.dir };
}

test('it starts a daemon that answers a handshake on the socket in the home', async () => {
  const ctx = setupTest();
  const daemon = startDaemonProcess({ command: resolveATCCommand(), home: ctx.dir });

  const client = await daemon.openClient();

  expect(client.sendHello('atc/test')).resolves.toContainKey('daemonID');
});

test('it keeps the daemon state in the home and records the daemon process there', async () => {
  const ctx = setupTest();
  const daemon = startDaemonProcess({ command: resolveATCCommand(), home: ctx.dir });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  expect(findDaemonRecord(join(ctx.dir, '.local', 'state', 'atc', 'daemon.json'))).toStrictEqual({
    pid: daemon.proc.pid,
    socketPath: join(ctx.dir, 'atc-daemon.sock'),
    reporterSocketPath: join(ctx.dir, 'atc.sock'),
    eventsSocketPath: join(ctx.dir, 'atc-events.sock'),
    listenPort: null,
  });
});

test('it hands the daemon the arguments and keeps its stderr readable', async () => {
  const ctx = setupTest();

  const daemon = startDaemonProcess({
    command: resolveATCCommand(),
    home: ctx.dir,
    args: ['--listen', '127.0.0.1:0'],
  });

  const exitCode = await daemon.proc.exited;

  expect({ exitCode, stderr: daemon.readStderr() }).toStrictEqual({
    exitCode: 1,
    stderr: expect.toInclude('--listen and --token-file go together'),
  });
});

test('it rejects a client with the daemon stderr when the daemon exits before it listens', async () => {
  const ctx = setupTest();

  const daemon = startDaemonProcess({
    command: resolveATCCommand(),
    home: ctx.dir,
    args: ['--listen', '127.0.0.1:0'],
  });

  const opening = daemon.openClient();

  await daemon.proc.exited;

  expect(opening).rejects.toThrowWithMessage(
    Error,
    /^the daemon exited \(1\) before it listened:\n.*--listen and --token-file go together/s,
  );
});

test('it rejects a client at once with the daemon stderr when the daemon exited before the client was opened', async () => {
  const ctx = setupTest();

  const daemon = startDaemonProcess({
    command: resolveATCCommand(),
    home: ctx.dir,
    args: ['--listen', '127.0.0.1:0'],
  });

  await daemon.proc.exited;

  expect(daemon.openClient()).rejects.toThrowWithMessage(
    Error,
    /^the daemon exited \(1\) before it listened:\n.*--listen and --token-file go together/s,
  );
});

test('it opens a client on the socket a replacement holds when the daemon exits before it listens', async () => {
  const ctx = setupTest();
  const nextPath = join(ctx.dir, 'next.sock');
  let accepted = 0;

  const replacement = Bun.listen({
    unix: nextPath,
    socket: {
      open() {
        accepted += 1;
      },
      data() {},
    },
  });

  registerTestCleanup(() => {
    replacement.stop(true);
  });

  const atc = createStubBin(join(ctx.dir, 'bin'), 'atc', buildStubHandoffDaemon(nextPath));
  const daemon = startDaemonProcess({ command: [atc], home: ctx.dir });

  await daemon.openClient();

  const exitCode = await daemon.proc.exited;

  await waitFor(() => {
    expect(accepted).toBe(1);
  });

  expect(exitCode).toBe(0);
});

test('it lays the config variables over the environment of the daemon', async () => {
  const ctx = setupTest();

  const daemon = startDaemonProcess({
    command: resolveATCCommand(),
    home: ctx.dir,
    env: { HOME: join(ctx.dir, 'other') },
  });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  expect(
    findDaemonRecord(join(ctx.dir, 'other', '.local', 'state', 'atc', 'daemon.json')),
  ).toStrictEqual({
    pid: daemon.proc.pid,
    socketPath: join(ctx.dir, 'atc-daemon.sock'),
    reporterSocketPath: join(ctx.dir, 'atc.sock'),
    eventsSocketPath: join(ctx.dir, 'atc-events.sock'),
    listenPort: null,
  });
});

test('it removes a variable the config sets to undefined from the environment of the daemon', async () => {
  const ctx = setupTest();

  const daemon = startDaemonProcess({
    command: resolveATCCommand(),
    home: ctx.dir,
    env: { XDG_RUNTIME_DIR: undefined },
  });

  // Without a runtime directory the daemon listens under its state
  // directory, which its record holds once it is up.
  const record = await waitFor(() => {
    const found = findDaemonRecord(join(ctx.dir, '.local', 'state', 'atc', 'daemon.json'));

    expect(found).not.toBeNull();

    return found;
  });

  expect(record).toStrictEqual({
    pid: daemon.proc.pid,
    socketPath: join(ctx.dir, '.local', 'state', 'atc', 'atc-daemon.sock'),
    reporterSocketPath: join(ctx.dir, '.local', 'state', 'atc', 'atc.sock'),
    eventsSocketPath: join(ctx.dir, '.local', 'state', 'atc', 'atc-events.sock'),
    listenPort: null,
  });
});

test('it restarts the daemon on the same home after the signal stops it', async () => {
  const ctx = setupTest();
  const daemon = startDaemonProcess({ command: resolveATCCommand(), home: ctx.dir });

  const first = await daemon.openClient();
  const before = await first.sendHello('atc/test');

  const crashed = daemon.proc;

  await daemon.restart('SIGKILL');

  const second = await daemon.openClient();
  const after = await second.sendHello('atc/test');

  expect(crashed.signalCode).toBe('SIGKILL');
  expect(daemon.proc.pid).not.toBe(crashed.pid);
  expect(after['daemonID']).toBe(before['daemonID']);
});

test('it keeps the stderr of two daemons on one home apart', async () => {
  const ctx = setupTest();
  const serving = startDaemonProcess({ command: resolveATCCommand(), home: ctx.dir });

  const client = await serving.openClient();

  await client.sendHello('atc/test');

  const refused = startDaemonProcess({
    command: resolveATCCommand(),
    home: ctx.dir,
    args: ['--listen', '127.0.0.1:0'],
  });

  await refused.proc.exited;

  expect(refused.readStderr()).toInclude('--listen and --token-file go together');
  expect(serving.readStderr()).not.toInclude('--listen and --token-file go together');
});

test('it kills the daemon once stopped', async () => {
  const ctx = setupTest();
  const daemon = startDaemonProcess({ command: resolveATCCommand(), home: ctx.dir });

  await daemon.openClient();
  await daemon.stop();

  expect(daemon.proc.signalCode).toBe('SIGKILL');
});

test('it kills the daemon the state directory records once stopped', async () => {
  const ctx = setupTest();
  const daemon = startDaemonProcess({ command: resolveATCCommand(), home: ctx.dir });
  const recorded = Bun.spawn(['sleep', '30']);

  onTestFinished(() => {
    recorded.kill();
  });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  writeFileSync(
    join(ctx.dir, '.local', 'state', 'atc', 'daemon.json'),
    JSON.stringify({
      pid: recorded.pid,
      socketPath: daemon.socketPath,
      reporterSocketPath: daemon.reporterSocketPath,
      eventsSocketPath: null,
      listenPort: null,
    }),
  );

  await daemon.stop();

  await recorded.exited;

  expect(recorded.signalCode).toBe('SIGKILL');
});

test('it kills the daemon once the test finishes without a stop', () => {
  const ctx = setupTest();

  // A stand-in that runs until killed and ignores the arguments after it.
  const daemon = startDaemonProcess({ command: ['bash', '-c', 'exec sleep 30'], home: ctx.dir });
  const pid = daemon.proc.pid;

  onTestFinished(() => {
    expect(isProcessAlive(pid)).toBeFalse();
  });
});

test('it kills the daemon its home records and removes its stderr directory once the test finishes', () => {
  const ctx = setupTest();
  let stderrLeft: boolean | null = null;
  let stderrDir = '';

  // Runs after the helper's releases, which register later, and before the
  // home goes; it records whether those releases left the stderr directory.
  registerTestCleanup(() => {
    stderrLeft = existsSync(stderrDir);
  });

  const daemon = startDaemonProcess({ command: ['bash', '-c', 'exec sleep 30'], home: ctx.dir });
  const pid = daemon.proc.pid;

  stderrDir = daemon.stderrDir;

  // Registered before the replacement starts, so it runs after the helper's
  // release and before the fallback kill below. The helper signals the
  // recorded daemon without waiting for it to exit.
  onTestFinished(async () => {
    expect(isProcessAlive(pid)).toBe(false);

    await waitFor(() => {
      expect(isProcessAlive(replacement.pid)).toBe(false);
    });

    expect(stderrLeft).toBe(false);
    expect(existsSync(ctx.dir)).toBe(false);
  });

  // A replacement daemon a restart would leave, recorded in the home.
  const replacement = Bun.spawn(['sleep', '30']);

  onTestFinished(() => {
    replacement.kill('SIGKILL');
  });

  mkdirSync(daemon.stateDir, { recursive: true });

  writeFileSync(
    join(daemon.stateDir, 'daemon.json'),
    JSON.stringify({
      pid: replacement.pid,
      socketPath: daemon.socketPath,
      reporterSocketPath: daemon.reporterSocketPath,
      eventsSocketPath: null,
      listenPort: null,
    }),
  );
});

test('it keeps the daemon stderr readable after a stop', async () => {
  const ctx = setupTest();

  const daemon = startDaemonProcess({
    command: resolveATCCommand(),
    home: ctx.dir,
    args: ['--listen', '127.0.0.1:0'],
  });

  await daemon.proc.exited;

  await daemon.stop();

  expect(daemon.readStderr()).toInclude('--listen and --token-file go together');
});

test('it refuses to restart a stopped daemon', async () => {
  const ctx = setupTest();

  // A stand-in that runs until killed and ignores the arguments after it.
  const daemon = startDaemonProcess({ command: ['bash', '-c', 'exec sleep 30'], home: ctx.dir });

  await daemon.stop();

  expect(daemon.restart('SIGTERM')).rejects.toThrowWithMessage(
    Error,
    'a stopped daemon process cannot restart',
  );
});
