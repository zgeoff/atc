import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { findPidFilePID } from './find-pid-file-pid';

function setupTest() {
  return setupTempDir('atc-pid-file-');
}

test('it reads the pid a pid file holds', () => {
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'daemon.pid'), '4242');

  expect(findPidFilePID(join(ctx.dir, 'daemon.pid'))).toBe(4242);
});

test('it reads null for a missing file', () => {
  using ctx = setupTest();

  expect(findPidFilePID(join(ctx.dir, 'daemon.pid'))).toBeNull();
});

test('it reads null for a file that holds something other than a pid above 1', () => {
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'daemon.pid'), '1');

  expect(findPidFilePID(join(ctx.dir, 'daemon.pid'))).toBeNull();
});
