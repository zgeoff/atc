import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { readDirBytes } from './read-dir-bytes';

test('it counts the files in nested folders and not what a symlink leads to', async () => {
  const temporaryDirectory = setupTempDir('atc-dir-bytes-');
  const folder = join(temporaryDirectory.path, 'session');
  const outside = join(temporaryDirectory.path, 'outside');

  mkdirSync(join(folder, 'scratch'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(folder, 'scratch', 'loaf.bin'), Buffer.alloc(64 * 1024, 1));
  writeFileSync(join(outside, 'flour.bin'), Buffer.alloc(1024 * 1024, 1));
  symlinkSync(outside, join(folder, 'pantry'));

  const bytes = await readDirBytes(folder);

  expect(bytes).toBeWithin(64 * 1024, 1024 * 1024);
});

test('it reads null for a folder that is not there', async () => {
  const temporaryDirectory = setupTempDir('atc-dir-bytes-');

  const bytes = await readDirBytes(join(temporaryDirectory.path, 'gone'));

  expect(bytes).toBeNull();
});
