import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubHandoffDaemon } from './build-stub-handoff-daemon';
import { createStubBin } from './create-stub-bin';
import { setupTempDir } from './setup-temp-dir';

// A temp directory that serves as the stand-in's home and holds the socket
// it hands over. Disposal removes it.
function setupTest() {
  const tmp = setupTempDir('atc-stub-handoff-');

  return { dir: tmp.dir, [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it moves the listening socket to the daemon socket of its home and exits 0', () => {
  using ctx = setupTest();

  const listening = Bun.listen({
    unix: join(ctx.dir, 'next.sock'),
    socket: { data() {} },
  });

  onTestFinished(() => {
    listening.stop(true);
  });

  const atc = createStubBin(
    join(ctx.dir, 'bin'),
    'atc',
    buildStubHandoffDaemon(join(ctx.dir, 'next.sock')),
  );

  const run = Bun.spawnSync([atc, 'daemon'], {
    env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' },
  });

  expect({
    exitCode: run.exitCode,
    handedOver: existsSync(join(ctx.dir, 'atc-daemon.sock')),
    left: existsSync(join(ctx.dir, 'next.sock')),
  }).toStrictEqual({ exitCode: 0, handedOver: true, left: false });
});
