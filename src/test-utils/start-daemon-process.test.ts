import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { findDaemonRecord } from '../shared/find-daemon-record';
import { resolveATCCommand } from './resolve-atc-command';
import { setupTempDir } from './setup-temp-dir';
import { startDaemonProcess } from './start-daemon-process';
import { waitFor } from './wait-for';

/**
 * A fresh home for one daemon process; a daemon that finds no config there
 * writes its own on first run.
 */
function setupTest() {
  return setupTempDir('atc-daemon-process-');
}

test('it starts a daemon that answers a handshake on the socket in the home', async () => {
  using ctx = setupTest();

  await using daemon = startDaemonProcess({ command: resolveATCCommand(), home: ctx.dir });

  const client = await daemon.openClient();

  expect(client.sendHello('atc/test')).resolves.toContainKey('daemonID');
});

test('it keeps the daemon state in the home and records the daemon process there', async () => {
  using ctx = setupTest();

  await using daemon = startDaemonProcess({ command: resolveATCCommand(), home: ctx.dir });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  expect(findDaemonRecord(join(ctx.dir, '.local', 'state', 'atc', 'daemon.json'))).toMatchObject({
    pid: daemon.proc.pid,
    socketPath: join(ctx.dir, 'atc-daemon.sock'),
    reporterSocketPath: join(ctx.dir, 'atc.sock'),
  });
});

test('it hands the daemon the arguments and keeps its stderr readable', async () => {
  using ctx = setupTest();

  await using daemon = startDaemonProcess({
    command: resolveATCCommand(),
    home: ctx.dir,
    args: ['--listen', '127.0.0.1:0'],
  });

  const code = await daemon.proc.exited;

  expect(code).toBe(1);
  expect(daemon.readStderr()).toInclude('--listen and --token-file go together');
});

test('it rejects a client with the daemon stderr when the daemon exits before it listens', async () => {
  using ctx = setupTest();

  await using daemon = startDaemonProcess({
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

test('it opens a client on the socket a replacement holds when the daemon exits before it listens', async () => {
  using ctx = setupTest();

  const nextPath = join(ctx.dir, 'next.sock');
  const replacement = Bun.listen({ unix: nextPath, socket: { data() {} } });

  onTestFinished(() => {
    replacement.stop(true);
  });

  // The stand-in daemon moves the listening socket into place and exits, as
  // a daemon handing its socket to a replacement does.
  await using daemon = startDaemonProcess({
    command: ['bash', '-c', `mv '${nextPath}' "$HOME/atc-daemon.sock"`, 'stand-in-atc'],
    home: ctx.dir,
  });

  const client = await daemon.openClient();

  expect(client).toBeInstanceOf(DaemonClient);
  expect(daemon.proc.exitCode).toBe(0);
});

test('it lays the config variables over the environment of the daemon', async () => {
  using ctx = setupTest();

  await using daemon = startDaemonProcess({
    command: resolveATCCommand(),
    home: ctx.dir,
    env: { HOME: join(ctx.dir, 'other') },
  });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  expect(
    findDaemonRecord(join(ctx.dir, 'other', '.local', 'state', 'atc', 'daemon.json')),
  ).toMatchObject({ pid: daemon.proc.pid });
});

test('it removes a variable the config sets to undefined from the environment of the daemon', async () => {
  using ctx = setupTest();

  await using daemon = startDaemonProcess({
    command: resolveATCCommand(),
    home: ctx.dir,
    env: { XDG_RUNTIME_DIR: undefined },
  });

  // Without a runtime directory the daemon listens under its state
  // directory, which its record holds once it is up.
  const record = await waitFor(() => {
    const found = findDaemonRecord(join(daemon.stateDir, 'daemon.json'));

    expect(found).not.toBeNull();

    return found;
  });

  expect(record).toMatchObject({ socketPath: join(daemon.stateDir, 'atc-daemon.sock') });
});

test('it restarts the daemon on the same home after the signal stops it', async () => {
  using ctx = setupTest();

  await using daemon = startDaemonProcess({ command: resolveATCCommand(), home: ctx.dir });

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

test('it kills the daemon on disposal', async () => {
  using ctx = setupTest();

  await using daemon = startDaemonProcess({ command: resolveATCCommand(), home: ctx.dir });

  await daemon.openClient();
  await daemon[Symbol.asyncDispose]();

  expect(daemon.proc.signalCode).toBe('SIGKILL');
});

test('it kills the daemon the state directory records on disposal', async () => {
  using ctx = setupTest();

  await using daemon = startDaemonProcess({ command: resolveATCCommand(), home: ctx.dir });

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

  await daemon[Symbol.asyncDispose]();

  await recorded.exited;

  expect(recorded.signalCode).toBe('SIGKILL');
});
