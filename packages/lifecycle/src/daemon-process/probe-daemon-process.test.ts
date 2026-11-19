import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from '@atc/config/host';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { probeDaemonProcess } from './probe-daemon-process';

function setupTest() {
  const directory = setupTempDir('is-daemon-process-').path;
  const cli = join(directory, 'checkout', 'src', 'cli.ts');

  mkdirSync(join(directory, 'checkout', 'src'), { recursive: true });
  writeFileSync(cli, "process.stdout.write('ready\\n');\nsetInterval(() => {}, 1000);\n");

  return { directory, cli };
}

test('it accepts a daemon process whose home holds this state directory', async () => {
  const ctx = setupTest();

  const daemon = Bun.spawn([process.execPath, ctx.cli, 'daemon'], {
    env: { HOME: join(ctx.directory, 'home'), PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
    stdout: 'pipe',
    stderr: 'ignore',
  });

  registerTestCleanup(async () => {
    daemon.kill();

    await daemon.exited;
  });

  // Before the child prints, its /proc entry can still show the pre-exec command line,
  // not the daemon's.
  await daemon.stdout.getReader().read();

  const accepted = probeDaemonProcess(
    daemon.pid,
    resolvePaths({ HOME: join(ctx.directory, 'home') }).stateDir,
    '/proc',
  );

  expect(accepted).toBeTrue();
});

test('it rejects a daemon process of another home', async () => {
  const ctx = setupTest();

  const daemon = Bun.spawn([process.execPath, ctx.cli, 'daemon'], {
    env: { HOME: join(ctx.directory, 'home'), PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
    stdout: 'pipe',
    stderr: 'ignore',
  });

  registerTestCleanup(async () => {
    daemon.kill();

    await daemon.exited;
  });

  // Before the child prints, its /proc entry can still show the pre-exec command line,
  // not the daemon's.
  await daemon.stdout.getReader().read();

  const accepted = probeDaemonProcess(
    daemon.pid,
    resolvePaths({ HOME: join(ctx.directory, 'other') }).stateDir,
    '/proc',
  );

  expect(accepted).toBeFalse();
});

test('it rejects a live process that is not an atc daemon', () => {
  const ctx = setupTest();

  const accepted = probeDaemonProcess(
    process.pid,
    resolvePaths({ HOME: join(ctx.directory, 'home') }).stateDir,
    '/proc',
  );

  expect(accepted).toBeFalse();
});

test('it rejects a pid with no process', () => {
  expect(probeDaemonProcess(2 ** 22 + 1, '/nowhere', '/proc')).toBeFalse();
});
