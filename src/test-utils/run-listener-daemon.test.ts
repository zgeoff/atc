import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

// A temp directory for the listener daemon's state, holding the token file
// it reads at start.
function setupTest() {
  const tmp = setupTempDir('atc-run-listener-');

  // The listener refuses to start without a token file.
  writeFileSync(join(tmp.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

  return { dir: tmp.dir, [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it prints the loopback port its TCP listener bound', async () => {
  using ctx = setupTest();

  await using proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'run-listener-daemon.ts')],
    {
      env: { ...process.env, ATC_TEST_DIR: ctx.dir },
      stdout: 'pipe',
      stderr: 'ignore',
    },
  );

  const read = await proc.stdout.getReader().read();

  const printed = new TextDecoder().decode(read.value);

  const connecting = Bun.connect({
    hostname: '127.0.0.1',
    port: Number(printed.trim()),
    socket: {
      open(socket) {
        socket.end();
      },
      data() {},
    },
  });

  expect(printed).toMatch(/^[1-9]\d*\n$/);

  await expect(connecting).toResolve();
});

test('it keeps its daemon socket in the test directory', async () => {
  using ctx = setupTest();

  await using proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'run-listener-daemon.ts')],
    {
      env: { ...process.env, ATC_TEST_DIR: ctx.dir },
      stdout: 'pipe',
      stderr: 'ignore',
    },
  );

  await proc.stdout.getReader().read();

  const client = await DaemonClient.open(join(ctx.dir, 'daemon.sock'));

  onTestFinished(() => {
    client.stop();
  });

  const hello = await client.sendHello('atc/test-build');

  expect(hello).toStrictEqual({
    daemon: 'atc/test-build',
    daemonID: expect.toBeString(),
    limits: { maxLine: 1_048_576, maxChunk: 65_536 },
    features: [
      'agents.list',
      'events.more',
      'events.session',
      'message.turn',
      'message.wait',
      'spawn.options',
      'daemon.id',
      'session.locator',
      'spawn.idempotency',
      'message.idempotency',
      'spawn.target',
      'request.principal',
      'spawn.workspace',
      'spawn.workspace.trust',
      'spawn.workspace.autoDir',
      'session.forget',
      'session.forget.preconditions',
      'session.submit',
      'report.get',
      'sources',
      'git.probe',
      'transport.tcp',
      'idempotency.replayOnly',
      'session.auth',
    ],
    idempotency: { completedRetentionMs: 86_400_000 },
    lastUsedAgent: 'claude',
  });
});

test('it logs a refused handshake on its stderr', async () => {
  using ctx = setupTest();

  await using proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'run-listener-daemon.ts')],
    {
      env: { ...process.env, ATC_TEST_DIR: ctx.dir },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  const stderr: string[] = [];

  void (async () => {
    for await (const chunk of proc.stderr.pipeThrough(new TextDecoderStream())) {
      stderr.push(chunk);
    }
  })();

  const read = await proc.stdout.getReader().read();

  const closed = Promise.withResolvers<void>();

  await Bun.connect({
    hostname: '127.0.0.1',
    port: Number(new TextDecoder().decode(read.value).trim()),
    socket: {
      open(socket) {
        socket.write('not a handshake\n');
      },
      data() {},
      close() {
        closed.resolve();
      },
    },
  });

  await closed.promise;

  await waitFor(() => {
    expect(stderr.join('')).toInclude('handshake_refused');
  });
});

test('it stops with exit code 0 on SIGTERM', async () => {
  using ctx = setupTest();

  await using proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'run-listener-daemon.ts')],
    {
      env: { ...process.env, ATC_TEST_DIR: ctx.dir },
      stdout: 'pipe',
      stderr: 'ignore',
    },
  );

  await proc.stdout.getReader().read();

  proc.kill('SIGTERM');

  const exitCode = await proc.exited;

  expect(exitCode).toBe(0);
});
