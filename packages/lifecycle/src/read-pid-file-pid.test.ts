import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { readPidFilePID } from './read-pid-file-pid';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-pid-file-');

  return { directory: temporaryDirectory.path };
}

test('it reads the pid a pid file holds', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'daemon.pid'), '4242');

  expect(readPidFilePID(join(ctx.directory, 'daemon.pid'))).toBe(4242);
});

test('it reads null for a missing file', () => {
  const ctx = setupTest();

  expect(readPidFilePID(join(ctx.directory, 'daemon.pid'))).toBeNull();
});

test('it reads null for a file that holds something other than a pid above 1', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'daemon.pid'), '1');

  expect(readPidFilePID(join(ctx.directory, 'daemon.pid'))).toBeNull();
});
