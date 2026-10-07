import { expect, onTestFinished, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { PROTOCOL_V } from '../protocol/protocol';
import { setupTempDir } from './setup-temp-dir';

// The legacy daemon in a process of its own, listening on a socket in a
// temp directory that is also its state directory, once it has printed
// that it is up.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-run-legacy-'));
  const socketPath = join(tmp.dir, 'daemon.sock');

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'run-legacy-daemon.ts'), socketPath, tmp.dir],
    { stdout: 'pipe', stderr: 'ignore' },
  );

  stack.defer(async () => {
    proc.kill();

    await proc.exited;
  });

  const stdout = proc.stdout.getReader();

  const up = await stdout.read();

  stdout.releaseLock();

  const owned = stack.move();

  return {
    dir: tmp.dir,
    socketPath,
    pid: proc.pid,
    up: new TextDecoder().decode(up.value),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it prints up once it listens', async () => {
  await using ctx = await setupTest();

  expect(ctx.up).toBe('up\n');
});

test('it records its pid and sockets in the state directory the way a daemon records itself', async () => {
  await using ctx = await setupTest();

  const record: unknown = JSON.parse(readFileSync(join(ctx.dir, 'daemon.json'), 'utf8'));

  expect(record).toStrictEqual({
    pid: ctx.pid,
    socketPath: ctx.socketPath,
    reporterSocketPath: `${ctx.socketPath}.reporter`,
    eventsSocketPath: null,
    listenPort: null,
  });
});

test('it refuses a handshake on the current protocol with protocol_mismatch', async () => {
  await using ctx = await setupTest();

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

  expect({
    exitCode: run.exitCode,
    usage: run.stderr.toString().includes('usage: run-legacy-daemon.ts <socket path> <state dir>'),
  }).toStrictEqual({ exitCode: 1, usage: true });
});
