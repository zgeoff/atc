import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { claimDaemonLock } from './claim-daemon-lock';

test('it refuses the lock while another holder keeps it', async () => {
  await using tmp = setupTempDir('atc-daemon-lock-');

  const lockPath = join(tmp.dir, 'daemon.lock');

  const first = await claimDaemonLock(lockPath, 0);

  onTestFinished(() => {
    first?.dispose();
  });

  const second = await claimDaemonLock(lockPath, 100);

  expect(first).not.toBeNull();
  expect(second).toBeNull();
});

test('it grants the lock once the previous holder lets go', async () => {
  await using tmp = setupTempDir('atc-daemon-lock-');

  const lockPath = join(tmp.dir, 'daemon.lock');

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
  await using tmp = setupTempDir('atc-daemon-lock-');

  const lockPath = join(tmp.dir, 'daemon.lock');

  const first = await claimDaemonLock(lockPath, 0);

  if (first === null) {
    throw new Error('the first claim found the lock held');
  }

  setTimeout(() => {
    first.dispose();
  }, 100);

  const second = await claimDaemonLock(lockPath, 2000);

  onTestFinished(() => {
    second?.dispose();
  });

  expect(second).not.toBeNull();
});
