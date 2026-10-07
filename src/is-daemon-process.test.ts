import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDaemonProcess } from './is-daemon-process';
import { setupTempDir } from './test-utils/setup-temp-dir';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const dir = stack.use(setupTempDir('is-daemon-process-')).dir;
  const cliPath = join(dir, 'checkout', 'src', 'cli.ts');

  await mkdir(join(dir, 'checkout', 'src'), { recursive: true });
  await writeFile(cliPath, "process.stdout.write('ready\\n');\nsetInterval(() => {}, 1000);\n");

  const proc = Bun.spawn([process.execPath, cliPath, 'daemon'], {
    env: { HOME: join(dir, 'home'), PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
    stdout: 'pipe',
    stderr: 'ignore',
  });

  stack.defer(async () => {
    proc.kill();

    await proc.exited;
  });

  // Until the child prints, its /proc entry can still hold the command line
  // it was forked with, before the exec that makes it the daemon.
  await proc.stdout.getReader().read();

  const owned = stack.move();

  return { dir, proc, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it accepts a daemon process whose home holds this state directory', async () => {
  await using ctx = await setupTest();

  expect(isDaemonProcess(ctx.proc.pid, join(ctx.dir, 'home', '.local', 'state', 'atc'))).toBeTrue();
});

test('it rejects a daemon process of another home', async () => {
  await using ctx = await setupTest();

  expect(
    isDaemonProcess(ctx.proc.pid, join(ctx.dir, 'other', '.local', 'state', 'atc')),
  ).toBeFalse();
});

test('it rejects a live process that is not an atc daemon', async () => {
  await using ctx = await setupTest();

  expect(isDaemonProcess(process.pid, join(ctx.dir, 'home', '.local', 'state', 'atc'))).toBeFalse();
});

test('it rejects a pid with no process', () => {
  expect(isDaemonProcess(2 ** 22 + 1, '/nowhere')).toBeFalse();
});
