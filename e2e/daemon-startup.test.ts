import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { findDaemonRecord } from '../src/shared/find-daemon-record';
import { getString } from '../src/test-utils/get-string';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { runATC } from '../src/test-utils/run-atc';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { startDaemonProcess } from '../src/test-utils/start-daemon-process';

/**
 * A fresh home for the daemons and atc commands a test starts; a daemon
 * that finds no config there writes its own on first run.
 */
function setupTest() {
  const tmp = setupTempDir('atc-e2e-startup-');

  return { home: tmp.dir, atc: resolveATCCommand() };
}

test('it lets exactly one of two daemons started at once serve a state directory', async () => {
  const ctx = setupTest();
  const first = startDaemonProcess({ command: ctx.atc, home: ctx.home });
  const second = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const loserCode = await Promise.race([first.proc.exited, second.proc.exited]);

  const live = [first, second].filter((daemon) => daemon.proc.exitCode === null);
  const [winner] = live;

  invariant(winner !== undefined, 'both daemons exited');

  // The loser can exit before the winner binds its socket, so the client
  // waits on the daemon that still runs.
  const client = await winner.openClient();

  await client.sendHello('atc/test');

  expect(loserCode).toBe(1);
  expect(live).toHaveLength(1);

  expect(findDaemonRecord(join(first.stateDir, 'daemon.json'))).toStrictEqual({
    pid: winner.proc.pid,
    socketPath: first.socketPath,
    reporterSocketPath: first.reporterSocketPath,
    eventsSocketPath: join(ctx.home, 'atc-events.sock'),
    listenPort: null,
  });

  expect(`${first.readStderr()}${second.readStderr()}`).toInclude('another daemon already serves');
});

test('it prints the running daemon id through atc daemon id', async () => {
  const ctx = setupTest();
  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();
  const hello = await client.sendHello('atc/test');
  const printed = await runATC({ command: ctx.atc, args: ['daemon', 'id'], home: ctx.home });

  expect(printed.stdout).toBe(`${getString(hello, 'daemonID')}\n`);
});

test('it exits nonzero from atc daemon id when no daemon answers', async () => {
  const ctx = setupTest();

  const printed = await runATC({ command: ctx.atc, args: ['daemon', 'id'], home: ctx.home });

  expect(printed.exitCode).toBe(1);
  expect(printed.stderr).toInclude('atc daemon id: no daemon at');
});

test.each([
  [['--listen', '0.0.0.0:0', '--token-file', '/dev/null'], "--listen refuses '0.0.0.0'"],
  [['--listen', '127.0.0.1:0'], '--listen and --token-file go together'],
])('it refuses to start a daemon with %j', async (args, message) => {
  const ctx = setupTest();

  const started = await runATC({ command: ctx.atc, args: ['daemon', ...args], home: ctx.home });

  expect(started.exitCode).toBe(1);
  expect(started.stderr).toInclude(message);
});

test('it refuses to start a daemon whose --listen port another socket holds, leaving no socket or record', async () => {
  const ctx = setupTest();
  const tokenFile = join(ctx.home, 'gateway-token');
  const held = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });

  onTestFinished(() => {
    held.stop(true);
  });

  writeFileSync(tokenFile, `${'a'.repeat(32)}\n`);

  const started = await runATC({
    command: ctx.atc,
    args: ['daemon', '--listen', `127.0.0.1:${held.port}`, '--token-file', tokenFile],
    home: ctx.home,
  });

  expect(started.exitCode).toBe(1);

  expect(started.stderr).toBe(
    `atc daemon: --listen cannot bind 127.0.0.1:${held.port} (EADDRINUSE)\n`,
  );

  expect(existsSync(join(ctx.home, 'atc-daemon.sock'))).toBeFalse();
  expect(existsSync(join(ctx.home, '.local', 'state', 'atc', 'daemon.json'))).toBeFalse();
});

// A compiled binary loads no .env file from its working directory, while the
// source entry keeps Bun's runtime autoload, so these run on the binary only.
// With no daemon running, `daemon id` prints the socket path it tried, which
// follows XDG_RUNTIME_DIR and so shows whether a variable reached the process.
test.skipIf(process.env['ATC_BIN'] === undefined)(
  'it ignores a .env file in the working directory of the compiled binary',
  async () => {
    const ctx = setupTest();

    writeFileSync(join(ctx.home, '.env'), `XDG_RUNTIME_DIR=${join(ctx.home, 'from-dotenv')}\n`);

    const result = await runATC({
      command: ctx.atc,
      args: ['daemon', 'id'],
      home: ctx.home,
      cwd: ctx.home,
      env: { XDG_RUNTIME_DIR: undefined },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toInclude(join(ctx.home, '.local', 'state', 'atc', 'atc-daemon.sock'));
    expect(result.stderr).not.toInclude('from-dotenv');
  },
);

test.skipIf(process.env['ATC_BIN'] === undefined)(
  'it keeps an explicitly inherited variable in the compiled binary',
  async () => {
    const ctx = setupTest();

    writeFileSync(join(ctx.home, '.env'), `XDG_RUNTIME_DIR=${join(ctx.home, 'from-dotenv')}\n`);

    const result = await runATC({
      command: ctx.atc,
      args: ['daemon', 'id'],
      home: ctx.home,
      cwd: ctx.home,
      env: { XDG_RUNTIME_DIR: join(ctx.home, 'from-process-env') },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toInclude(join(ctx.home, 'from-process-env', 'atc-daemon.sock'));
  },
);
