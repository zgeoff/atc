import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

// The listener daemon in a process of its own, with its state in a temp
// directory, once it has printed its port; `stderr` collects what it logs.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-run-listener-'));

  // The listener refuses to start without a token file.
  writeFileSync(join(tmp.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

  const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'run-listener-daemon.ts')], {
    env: { ...process.env, ATC_TEST_DIR: tmp.dir },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  stack.defer(async () => {
    proc.kill('SIGKILL');

    await proc.exited;
  });

  const stderr: string[] = [];

  void (async () => {
    for await (const chunk of proc.stderr.pipeThrough(new TextDecoderStream())) {
      stderr.push(chunk);
    }
  })();

  const stdout = proc.stdout.getReader();

  const first = await stdout.read();

  stdout.releaseLock();

  const owned = stack.move();

  return {
    dir: tmp.dir,
    proc,
    stderr,
    printed: new TextDecoder().decode(first.value),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it prints the loopback port its TCP listener bound', async () => {
  await using ctx = await setupTest();

  const connecting = Bun.connect({
    hostname: '127.0.0.1',
    port: Number(ctx.printed.trim()),
    socket: {
      open(socket) {
        socket.end();
      },
      data() {},
    },
  });

  expect(ctx.printed).toMatch(/^[1-9]\d*\n$/);

  await expect(connecting).toResolve();
});

test('it keeps its daemon socket in the test directory', async () => {
  await using ctx = await setupTest();

  const client = await DaemonClient.open(join(ctx.dir, 'daemon.sock'));

  onTestFinished(() => {
    client.stop();
  });

  const hello = await client.sendHello('atc/test-build');

  expect(hello).toMatchObject({ daemon: 'atc/test-build' });
});

test('it logs a refused handshake on its stderr', async () => {
  await using ctx = await setupTest();

  const closed = Promise.withResolvers<void>();

  await Bun.connect({
    hostname: '127.0.0.1',
    port: Number(ctx.printed.trim()),
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
    expect(ctx.stderr.join('')).toInclude('handshake_refused');
  });
});

test('it stops with exit code 0 on SIGTERM', async () => {
  await using ctx = await setupTest();

  ctx.proc.kill('SIGTERM');

  const exitCode = await ctx.proc.exited;

  expect(exitCode).toBe(0);
});
