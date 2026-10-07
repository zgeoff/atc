import { expect, onTestFinished, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { PROTOCOL_V } from '../protocol/protocol';
import { setupTempDir } from './setup-temp-dir';

// A temp directory that holds the legacy daemon's socket and serves as its
// state directory.
function setupTest() {
  const tmp = setupTempDir('atc-run-legacy-');

  return {
    dir: tmp.dir,
    socketPath: join(tmp.dir, 'daemon.sock'),
    [Symbol.dispose]: tmp[Symbol.dispose],
  };
}

test('it prints up once it listens', async () => {
  using ctx = setupTest();

  await using proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'run-legacy-daemon.ts'), ctx.socketPath, ctx.dir],
    { stdout: 'pipe', stderr: 'ignore' },
  );

  const printed = await proc.stdout.getReader().read();

  expect(new TextDecoder().decode(printed.value)).toBe('up\n');
});

test('it records its pid and sockets in the state directory the way a daemon records itself', async () => {
  using ctx = setupTest();

  await using proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'run-legacy-daemon.ts'), ctx.socketPath, ctx.dir],
    { stdout: 'pipe', stderr: 'ignore' },
  );

  await proc.stdout.getReader().read();

  const record: unknown = JSON.parse(readFileSync(join(ctx.dir, 'daemon.json'), 'utf8'));

  expect(record).toStrictEqual({
    pid: proc.pid,
    socketPath: ctx.socketPath,
    reporterSocketPath: `${ctx.socketPath}.reporter`,
    eventsSocketPath: null,
    listenPort: null,
  });
});

test('it refuses a handshake on the current protocol with protocol_mismatch', async () => {
  using ctx = setupTest();

  await using proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'run-legacy-daemon.ts'), ctx.socketPath, ctx.dir],
    { stdout: 'pipe', stderr: 'ignore' },
  );

  await proc.stdout.getReader().read();

  const client = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  expect(client.sendHello('atc/test-build')).rejects.toMatchObject({
    code: 'protocol_mismatch',
    message: `atc/test-build speaks protocol v${PROTOCOL_V}, daemon atc/legacy-build speaks v${PROTOCOL_V + 1}; restart the daemon so both run the same build`,
  });
});

test('it stops with a usage error when given no socket path and state directory', () => {
  const run = Bun.spawnSync([process.execPath, join(import.meta.dir, 'run-legacy-daemon.ts')], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect({ exitCode: run.exitCode, stderr: run.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: expect.toInclude('usage: run-legacy-daemon.ts <socket path> <state dir>'),
  });
});
