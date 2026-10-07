import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDaemonProcess } from './is-daemon-process';
import { setupTempDir } from './test-utils/setup-temp-dir';

function setupTest() {
  using stack = new DisposableStack();

  const dir = stack.use(setupTempDir('is-daemon-process-')).dir;
  const cli = join(dir, 'checkout', 'src', 'cli.ts');

  // A checkout entry that a process started as `cli.ts daemon` runs, so its
  // command line reads as the daemon's: it prints once it runs, then idles.
  mkdirSync(join(dir, 'checkout', 'src'), { recursive: true });
  writeFileSync(cli, "process.stdout.write('ready\\n');\nsetInterval(() => {}, 1000);\n");

  const owned = stack.move();

  return {
    dir,
    cli,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it accepts a daemon process whose home holds this state directory', async () => {
  using ctx = setupTest();

  const daemon = Bun.spawn([process.execPath, ctx.cli, 'daemon'], {
    env: { HOME: join(ctx.dir, 'home'), PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
    stdout: 'pipe',
    stderr: 'ignore',
  });

  onTestFinished(async () => {
    daemon.kill();

    await daemon.exited;
  });

  // Until the child prints, its /proc entry can still hold the command line
  // it was forked with, before the exec that makes it the daemon.
  await daemon.stdout.getReader().read();

  const accepted = isDaemonProcess(daemon.pid, join(ctx.dir, 'home', '.local', 'state', 'atc'));

  expect(accepted).toBeTrue();
});

test('it rejects a daemon process of another home', async () => {
  using ctx = setupTest();

  const daemon = Bun.spawn([process.execPath, ctx.cli, 'daemon'], {
    env: { HOME: join(ctx.dir, 'home'), PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
    stdout: 'pipe',
    stderr: 'ignore',
  });

  onTestFinished(async () => {
    daemon.kill();

    await daemon.exited;
  });

  // Until the child prints, its /proc entry can still hold the command line
  // it was forked with, before the exec that makes it the daemon.
  await daemon.stdout.getReader().read();

  const accepted = isDaemonProcess(daemon.pid, join(ctx.dir, 'other', '.local', 'state', 'atc'));

  expect(accepted).toBeFalse();
});

test('it rejects a live process that is not an atc daemon', () => {
  using ctx = setupTest();

  expect(isDaemonProcess(process.pid, join(ctx.dir, 'home', '.local', 'state', 'atc'))).toBeFalse();
});

test('it rejects a pid with no process', () => {
  expect(isDaemonProcess(2 ** 22 + 1, '/nowhere')).toBeFalse();
});
