import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { readSubdirNames } from './read-subdir-names';

test('it reads the names of the folders under a folder, and of no file or symlink', async () => {
  const temporaryDirectory = setupTempDir('atc-subdir-names-');

  mkdirSync(join(temporaryDirectory.path, 'session-a'));
  writeFileSync(join(temporaryDirectory.path, 'status.json'), '{}');
  symlinkSync(join(temporaryDirectory.path, 'session-a'), join(temporaryDirectory.path, 'link'));

  const names = await readSubdirNames(temporaryDirectory.path);

  expect(names).toStrictEqual(['session-a']);
});

test('it reads no names under a folder that is not there', async () => {
  const temporaryDirectory = setupTempDir('atc-subdir-names-');

  const names = await readSubdirNames(join(temporaryDirectory.path, 'gone'));

  expect(names).toStrictEqual([]);
});

test('it rejects a path that is a file', () => {
  const temporaryDirectory = setupTempDir('atc-subdir-names-');
  const file = join(temporaryDirectory.path, 'status.json');

  writeFileSync(file, '{}');

  expect(readSubdirNames(file)).rejects.toThrow();
});
