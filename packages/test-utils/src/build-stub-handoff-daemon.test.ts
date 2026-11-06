import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubHandoffDaemon } from './build-stub-handoff-daemon';
import { createStubBin } from './create-stub-bin';
import { registerTestCleanup } from './register-test-cleanup';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';

// A temp directory that holds the socket the stand-in hands over, removed
// once the test finishes.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-handoff-');

  return { directory: temporaryDirectory.path };
}

test('it moves the listening socket to the daemon socket path it is given and exits 0', async () => {
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
    buildStubHandoffDaemon(join(ctx.directory, 'next.sock'), join(ctx.directory, 'handed.sock')),
  );

  const run = await runCommand([atc, 'daemon'], { env: { PATH: '/usr/bin:/bin' } });

  expect(run.exitCode).toBe(0);
  expect(existsSync(join(ctx.directory, 'handed.sock'))).toBe(true);
  expect(existsSync(join(ctx.directory, 'next.sock'))).toBe(false);
});
