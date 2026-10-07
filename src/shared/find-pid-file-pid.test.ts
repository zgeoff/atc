import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { findPidFilePID } from './find-pid-file-pid';

test('it reads the pid a pid file holds', async () => {
  await using tmp = setupTempDir('atc-pid-file-');

  await Bun.write(join(tmp.dir, 'daemon.pid'), '4242');

  expect(findPidFilePID(join(tmp.dir, 'daemon.pid'))).toBe(4242);
});

test('it reads null for a missing file', () => {
  using tmp = setupTempDir('atc-pid-file-');

  expect(findPidFilePID(join(tmp.dir, 'daemon.pid'))).toBeNull();
});

test('it reads null for a file that holds something other than a pid above 1', async () => {
  await using tmp = setupTempDir('atc-pid-file-');

  await Bun.write(join(tmp.dir, 'daemon.pid'), '1');

  expect(findPidFilePID(join(tmp.dir, 'daemon.pid'))).toBeNull();
});
