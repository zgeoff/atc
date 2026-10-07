import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

  return { home: tmp.dir, atc: resolveATCCommand(), [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it lets exactly one of two daemons started at once serve a state directory', async () => {
  using ctx = setupTest();

  await using first = startDaemonProcess({ command: ctx.atc, home: ctx.home });
  await using second = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const loserCode = await Promise.race([first.proc.exited, second.proc.exited]);
  const client = await first.openClient();

  await client.sendHello('atc/test');

  const live = [first, second].filter((daemon) => daemon.proc.exitCode === null);

  expect(loserCode).toBe(1);
  expect(live).toHaveLength(1);

  expect(findDaemonRecord(join(first.stateDir, 'daemon.json'))).toMatchObject({
    pid: live[0]?.proc.pid,
    socketPath: first.socketPath,
  });

  expect(`${first.readStderr()}${second.readStderr()}`).toInclude('another daemon already serves');
});

test('it prints the running daemon id through atc daemon id', async () => {
  using ctx = setupTest();

  await using daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();
  const hello = await client.sendHello('atc/test');
  const printed = await runATC({ command: ctx.atc, args: ['daemon', 'id'], home: ctx.home });

  expect(printed.stdout).toBe(`${getString(hello, 'daemonID')}\n`);
});

test('it exits nonzero from atc daemon id when no daemon answers', async () => {
  using ctx = setupTest();

  const printed = await runATC({ command: ctx.atc, args: ['daemon', 'id'], home: ctx.home });

  expect(printed.exitCode).toBe(1);
  expect(printed.stderr).toInclude('atc daemon id: no daemon at');
});

test.each([
  [['--listen', '0.0.0.0:0', '--token-file', '/dev/null'], "--listen refuses '0.0.0.0'"],
  [['--listen', '127.0.0.1:0'], '--listen and --token-file go together'],
])('it refuses to start a daemon with %j', async (args, message) => {
  using ctx = setupTest();

  const started = await runATC({ command: ctx.atc, args: ['daemon', ...args], home: ctx.home });

  expect(started.exitCode).toBe(1);
  expect(started.stderr).toInclude(message);
});

test('it refuses to start a daemon whose --listen port another socket holds, leaving no socket or record', async () => {
  using ctx = setupTest();

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
    using ctx = setupTest();

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
    using ctx = setupTest();

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
