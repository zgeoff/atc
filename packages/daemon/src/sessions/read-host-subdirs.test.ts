import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { buildStubLocalProvider } from '../testing/build-stub-local-provider';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { readHostSubdirs } from './read-host-subdirs';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-host-subdirs-');

  return { directory: temporaryDirectory.path, provider: buildStubLocalProvider() };
}

test('it lists each folder under a folder, and no file or symlink', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'bakery-main'));
  mkdirSync(join(ctx.directory, 'line\nbreak'));
  writeFileSync(join(ctx.directory, 'notes.txt'), 'rye\n');
  symlinkSync(join(ctx.directory, 'bakery-main'), join(ctx.directory, 'bakery-link'));

  const folders = await readHostSubdirs(ctx.provider, null, ctx.directory);

  expect(folders.toSorted()).toStrictEqual([
    join(ctx.directory, 'bakery-main'),
    join(ctx.directory, 'line\nbreak'),
  ]);
});

test('it rejects with the host error when the host cannot list the folder', () => {
  const provider = buildStubMemoryProvider({
    runCommand: () =>
      Promise.resolve({
        exitCode: 1,
        stdout: '',
        stderr: "find: '/w/pantry': Permission denied\n",
      }),
  });

  expect(readHostSubdirs(provider, null, '/w/pantry')).rejects.toThrow(
    "atc could not list the folders under /w/pantry: find: '/w/pantry': Permission denied",
  );
});

test('it lists none under a folder that is not there', async () => {
  const ctx = setupTest();

  const folders = await readHostSubdirs(ctx.provider, null, join(ctx.directory, 'gone'));

  expect(folders).toStrictEqual([]);
});
