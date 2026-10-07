import { expect, onTestFinished, test } from 'bun:test';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { buildStubClock } from '../test-utils/build-stub-clock';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { claimDaemonLock } from './claim-daemon-lock';

function setupTest() {
  const tmp = setupTempDir('atc-daemon-lock-');

  return { dir: tmp.dir, [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it refuses the lock while another holder keeps it past the wait', async () => {
  using ctx = setupTest();

  const lockPath = join(ctx.dir, 'daemon.lock');
  const clock = buildStubClock(0);

  const first = await claimDaemonLock(lockPath, 0, clock);

  onTestFinished(() => {
    first?.dispose();
  });

  invariant(first !== null, 'the first claim found the lock held');

  const claim = claimDaemonLock(lockPath, 100, clock);

  clock.advance(100);

  const second = await claim;

  expect(second).toBeNull();
});

test('it grants the lock once the previous holder lets go', async () => {
  using ctx = setupTest();

  const lockPath = join(ctx.dir, 'daemon.lock');

  const first = await claimDaemonLock(lockPath, 0);

  onTestFinished(() => {
    first?.dispose();
  });

  invariant(first !== null, 'the first claim found the lock held');

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
  const clock = buildStubClock(0);

  const first = await claimDaemonLock(lockPath, 0, clock);

  onTestFinished(() => {
    first?.dispose();
  });

  invariant(first !== null, 'the first claim found the lock held');

  const claim = claimDaemonLock(lockPath, 2000, clock);

  first.dispose();
  clock.advance(50);

  const second = await claim;

  onTestFinished(() => {
    second?.dispose();
  });

  expect(second).not.toBeNull();
});

test('it throws when the lock file cannot be opened for reading and writing', () => {
  using ctx = setupTest();

  const lockPath = join(ctx.dir, 'daemon.lock');

  writeFileSync(lockPath, '');
  chmodSync(lockPath, 0o200);

  expect(claimDaemonLock(lockPath, 0)).rejects.toThrow(
    `atc daemon: cannot open the lock file ${lockPath}`,
  );
});
