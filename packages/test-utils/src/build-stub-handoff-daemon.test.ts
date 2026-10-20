import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubHandoffDaemon } from './build-stub-handoff-daemon';
import { createStubBin } from './create-stub-bin';
import { registerTestCleanup } from './register-test-cleanup';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';

// A temp directory that serves as the stand-in's home and holds the socket
// it hands over, removed once the test finishes.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-handoff-');

  return { directory: temporaryDirectory.path };
}

test('it moves the listening socket to the daemon socket of its home and exits 0', async () => {
  const ctx = setupTest();

  const listening = Bun.listen({
    unix: join(ctx.directory, 'next.sock'),
    socket: { data() {} },
  });

  registerTestCleanup(() => {
    listening.stop(true);
  });

  const atc = createStubBin(
    join(ctx.directory, 'bin'),
    'atc',
    buildStubHandoffDaemon(join(ctx.directory, 'next.sock')),
  );

  const run = await runCommand([atc, 'daemon'], {
    env: { HOME: ctx.directory, PATH: '/usr/bin:/bin' },
  });

  expect(run.exitCode).toBe(0);
  expect(existsSync(join(ctx.directory, 'atc-daemon.sock'))).toBe(true);
  expect(existsSync(join(ctx.directory, 'next.sock'))).toBe(false);
});
