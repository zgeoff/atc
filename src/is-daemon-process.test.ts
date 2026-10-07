import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDaemonProcess } from './is-daemon-process';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const dir = await mkdtemp(join(tmpdir(), 'is-daemon-process-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

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
  await using daemon = await setupTest();

  expect(
    isDaemonProcess(daemon.proc.pid, join(daemon.dir, 'home', '.local', 'state', 'atc')),
  ).toBeTrue();
});

test('it rejects a daemon process of another home', async () => {
  await using daemon = await setupTest();

  expect(
    isDaemonProcess(daemon.proc.pid, join(daemon.dir, 'other', '.local', 'state', 'atc')),
  ).toBeFalse();
});

test('it rejects a live process that is not an atc daemon', async () => {
  await using daemon = await setupTest();

  expect(
    isDaemonProcess(process.pid, join(daemon.dir, 'home', '.local', 'state', 'atc')),
  ).toBeFalse();
});

test('it rejects a pid with no process', () => {
  expect(isDaemonProcess(2 ** 22 + 1, '/nowhere')).toBeFalse();
});
