import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { claimDaemonLock } from './claim-daemon-lock';

function setupTest() {
  const tmp = setupTempDir('atc-daemon-lock-');

  return { dir: tmp.dir, [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it refuses the lock while another holder keeps it', async () => {
  using ctx = setupTest();

  const lockPath = join(ctx.dir, 'daemon.lock');

  const first = await claimDaemonLock(lockPath, 0);

  onTestFinished(() => {
    first?.dispose();
  });

  if (first === null) {
    throw new Error('the first claim found the lock held');
  }

  const second = await claimDaemonLock(lockPath, 100);

  expect(second).toBeNull();
});

test('it grants the lock once the previous holder lets go', async () => {
  using ctx = setupTest();

  const lockPath = join(ctx.dir, 'daemon.lock');

  const first = await claimDaemonLock(lockPath, 0);

  if (first === null) {
    throw new Error('the first claim found the lock held');
  }

  first.dispose();

  const second = await claimDaemonLock(lockPath, 0);

  onTestFinished(() => {
    second?.dispose();
  });

  expect(second).not.toBeNull();
});

test('it waits for a holder that lets go within the wait', async () => {
  using ctx = setupTest();

  const lockPath = join(ctx.dir, 'daemon.lock');

  const first = await claimDaemonLock(lockPath, 0);

  if (first === null) {
    throw new Error('the first claim found the lock held');
  }

  const claim = claimDaemonLock(lockPath, 2000);

  first.dispose();

  const second = await claim;

  onTestFinished(() => {
    second?.dispose();
  });

  expect(second).not.toBeNull();
});
