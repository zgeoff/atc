import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { removeStaleTestHomes } from './remove-stale-test-homes';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stale-test-homes-');

  return { directory: temporaryDirectory.path };
}

test('it removes the run directory of an owner that has exited', async () => {
  const ctx = setupTest();
  const root = join(ctx.directory, 'atc-test-home-ended');
  const owner = Bun.spawn(['true']);

  await owner.exited;

  mkdirSync(join(root, 'home'), { recursive: true });
  writeFileSync(join(root, 'owner.pid'), `${owner.pid}\n`);

  const removed = await removeStaleTestHomes({
    tmpDir: ctx.directory,
    procRoot: '/proc',
    ownPID: process.pid,
    nowMs: Date.now(),
  });

  expect(removed).toStrictEqual([root]);
  expect(existsSync(root)).toBeFalse();
});

// The processes are read from /proc, which only Linux has.
test.skipIf(process.platform !== 'linux')(
  'it kills a process left running in the run directory of an owner that has exited',
  async () => {
    const ctx = setupTest();
    const root = join(ctx.directory, 'atc-test-home-ended');
    const owner = Bun.spawn(['true']);

    await owner.exited;

    mkdirSync(root);
    writeFileSync(join(root, 'owner.pid'), `${owner.pid}\n`);

    const left = Bun.spawn(['sleep', '30'], { env: { ...process.env, ATC_TEST_HOME: root } });

    onTestFinished(() => {
      left.kill('SIGKILL');
    });

    await removeStaleTestHomes({
      tmpDir: ctx.directory,
      procRoot: '/proc',
      ownPID: process.pid,
      nowMs: Date.now(),
    });

    await left.exited;

    expect(left.signalCode).toBe('SIGKILL');
  },
);

test('it never removes the run directory of an owner that still runs', async () => {
  const ctx = setupTest();
  const root = join(ctx.directory, 'atc-test-home-running');
  const owner = Bun.spawn(['sleep', '30']);

  onTestFinished(() => {
    owner.kill('SIGKILL');
  });

  mkdirSync(root);
  writeFileSync(join(root, 'owner.pid'), `${owner.pid}\n`);

  const removed = await removeStaleTestHomes({
    tmpDir: ctx.directory,
    procRoot: '/proc',
    ownPID: process.pid,
    nowMs: Date.now(),
  });

  expect(removed).toStrictEqual([]);
  expect(existsSync(root)).toBeTrue();
});

test('it keeps a run directory with no owner file for an hour', async () => {
  const ctx = setupTest();
  const root = join(ctx.directory, 'atc-test-home-starting');

  mkdirSync(root);

  const removed = await removeStaleTestHomes({
    tmpDir: ctx.directory,
    procRoot: '/proc',
    ownPID: process.pid,
    nowMs: statSync(root).mtimeMs + 60 * 60 * 1000,
  });

  expect(removed).toStrictEqual([]);
});

test('it removes a run directory with no owner file after an hour', async () => {
  const ctx = setupTest();
  const root = join(ctx.directory, 'atc-test-home-unowned');

  mkdirSync(root);

  const removed = await removeStaleTestHomes({
    tmpDir: ctx.directory,
    procRoot: '/proc',
    ownPID: process.pid,
    nowMs: statSync(root).mtimeMs + 60 * 60 * 1000 + 1,
  });

  expect(removed).toStrictEqual([root]);
});

test('it never removes a folder whose name lacks the run directory prefix', async () => {
  const ctx = setupTest();
  const other = join(ctx.directory, 'atc-other');
  const owner = Bun.spawn(['true']);

  await owner.exited;

  mkdirSync(other);
  writeFileSync(join(other, 'owner.pid'), `${owner.pid}\n`);

  const removed = await removeStaleTestHomes({
    tmpDir: ctx.directory,
    procRoot: '/proc',
    ownPID: process.pid,
    nowMs: statSync(other).mtimeMs + 2 * 60 * 60 * 1000,
  });

  expect(removed).toStrictEqual([]);
  expect(existsSync(other)).toBeTrue();
});
