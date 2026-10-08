import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

// The listener daemon running on state in a temp directory, with what it
// printed once it listened and everything it writes to stderr. Cleanup kills
// the daemon, then removes the directory.
async function setupTest() {
  const tmp = setupTempDir('atc-run-listener-');

  // The listener refuses to start without a token file.
  writeFileSync(join(tmp.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

  const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'run-listener-daemon.ts')], {
    env: { ...process.env, ATC_TEST_DIR: tmp.dir },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  registerTestCleanup(async () => {
    proc.kill();

    await proc.exited;
  });

  const stderr: string[] = [];

  void (async () => {
    for await (const chunk of proc.stderr.pipeThrough(new TextDecoderStream())) {
      stderr.push(chunk);
    }
  })();

  const read = await proc.stdout.getReader().read();

  const printed = new TextDecoder().decode(read.value);

  return { proc, printed, stderr, dir: tmp.dir };
}

test('it prints the loopback port its TCP listener bound', async () => {
  const ctx = await setupTest();

  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port: Number(ctx.printed.trim()),
    socket: { data() {} },
  });

  registerTestCleanup(() => socket.end());

  expect(ctx.printed).toMatch(/^[1-9]\d*\n$/);
  expect(socket.remotePort).toBe(Number(ctx.printed.trim()));
});

test('it answers a hello on the daemon socket in its test directory', async () => {
  const ctx = await setupTest();
  const client = await DaemonClient.open(join(ctx.dir, 'daemon.sock'));

  registerTestCleanup(() => {
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
      'session.record',
    ],
    idempotency: { completedRetentionMs: 86_400_000 },
    lastUsedAgent: 'claude',
  });
});

test('it logs a refused handshake on its stderr', async () => {
  const ctx = await setupTest();

  const closed = Promise.withResolvers<void>();

  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port: Number(ctx.printed.trim()),
    socket: {
      open(opened) {
        opened.write('not a handshake\n');
      },
      data() {},
      close() {
        closed.resolve();
      },
    },
  });

  registerTestCleanup(() => socket.end());

  await closed.promise;

  await waitFor(() => {
    expect(ctx.stderr.join('')).toInclude('handshake_refused');
  });
});

test('it stops with exit code 0 on SIGTERM', async () => {
  const ctx = await setupTest();

  ctx.proc.kill('SIGTERM');

  const exitCode = await ctx.proc.exited;

  expect(exitCode).toBe(0);
});
