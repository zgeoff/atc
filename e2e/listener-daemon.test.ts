import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import { registerTestCleanup, setupTempDir, waitFor } from '@atc/test-utils';

// The listener daemon running on state in a temp directory, with what it
// printed once it listened and everything it writes to stderr. Cleanup kills
// the daemon, then removes the directory.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-run-listener-');

  // The listener refuses to start without a token file.
  writeFileSync(join(temporaryDirectory.path, 'gateway-token'), `${'a'.repeat(32)}\n`);

  const subprocess = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'packages', 'daemon', 'src', 'testing', 'run-listener-daemon.ts'),
    ],
    {
      env: { ...process.env, ATC_TEST_DIR: temporaryDirectory.path },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  registerTestCleanup(async () => {
    subprocess.kill();

    await subprocess.exited;
  });

  const stderr: string[] = [];

  void (async () => {
    for await (const chunk of subprocess.stderr.pipeThrough(new TextDecoderStream())) {
      stderr.push(chunk);
    }
  })();

  const read = await subprocess.stdout.getReader().read();

  const printed = new TextDecoder().decode(read.value);

  return { subprocess, printed, stderr, directory: temporaryDirectory.path };
}

test('it prints the loopback port its TCP listener bound', async () => {
  const ctx = await setupTest();

  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port: Number(ctx.printed.trim()),
    socket: { data() {} },
  });

  registerTestCleanup(() => socket.end());

  expect(ctx.printed).toMatch(/^[1-9]\d*\n$/u);
  expect(socket.remotePort).toBe(Number(ctx.printed.trim()));
});

test('it answers a hello on the daemon socket in its test directory', async () => {
  const ctx = await setupTest();
  const client = await openDaemonClient(join(ctx.directory, 'daemon.sock'));

  registerTestCleanup(() => {
    client.stop();
  });

  const hello = await client.sendHello('atc/test-build');

  expect(hello).toStrictEqual({
    daemon: 'atc/test-build',
    daemonID: expect.toBeString(),
    limits: { maxLine: 1_048_576, maxChunk: 65_536 },
    idempotency: { completedRetentionMs: 86_400_000 },
    lastUsedAgent: 'claude',
    peerSession: null,
    features: ['events.read.from-start', 'daemon.hello.viewer'],
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

  ctx.subprocess.kill('SIGTERM');

  const exitCode = await ctx.subprocess.exited;

  expect(exitCode).toBe(0);
});
