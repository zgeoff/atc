import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { registerTestCleanup } from '@zgeoff/testing';
import { createStubBin } from '@zgeoff/testing/bin';
import { createTempDir } from '@zgeoff/testing/fs';
import { run } from '@zgeoff/testing/process';
import { buildStubHandoffDaemon } from './build-stub-handoff-daemon';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-stub-handoff-');

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

  const atc = createStubBin(join(ctx.directory, 'bin'), 'atc', {
    script: buildStubHandoffDaemon(
      join(ctx.directory, 'next.sock'),
      join(ctx.directory, 'handed.sock'),
    ),
  }).path;

  const result = await run([atc, 'daemon'], { env: { PATH: '/usr/bin:/bin' } });

  expect(result.exitCode).toBe(0);
  expect(existsSync(join(ctx.directory, 'handed.sock'))).toBe(true);
  expect(existsSync(join(ctx.directory, 'next.sock'))).toBe(false);
});
