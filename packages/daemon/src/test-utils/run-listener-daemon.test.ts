import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerTestCleanup } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-run-listener-');

  // The listener refuses to start without a token file.
  writeFileSync(join(temporaryDirectory.path, 'gateway-token'), `${'a'.repeat(32)}\n`);

  const subprocess = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'run-listener-daemon.ts')],
    {
      env: { ATC_TEST_DIR: temporaryDirectory.path, HOME: temporaryDirectory.path },
      stdout: 'pipe',
      stderr: 'ignore',
    },
  );

  registerTestCleanup(async () => {
    subprocess.kill('SIGKILL');

    await subprocess.exited;
  });

  const readPort = async () => {
    const printed = await subprocess.stdout.getReader().read();

    return Number(new TextDecoder().decode(printed.value).trim());
  };

  return { subprocess, readPort };
}

test('it prints the port it listens on', async () => {
  const ctx = setupTest();

  const port = await ctx.readPort();

  expect(port).toBeGreaterThan(0);
});

test('it accepts a connection on the port it printed', async () => {
  const ctx = setupTest();

  const port = await ctx.readPort();

  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: { data() {}, error() {} },
  });

  socket.end();
});

test('it stops with exit code 0 on SIGTERM', async () => {
  const ctx = setupTest();

  await ctx.readPort();

  ctx.subprocess.kill('SIGTERM');

  const exitCode = await ctx.subprocess.exited;

  expect(exitCode).toBe(0);
});
