import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { buildStubLocalProvider } from '../testing/build-stub-local-provider';
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

  const folders = await readHostSubdirs(ctx.provider, ctx.directory);

  expect(folders.toSorted()).toStrictEqual([
    join(ctx.directory, 'bakery-main'),
    join(ctx.directory, 'line\nbreak'),
  ]);
});

// root searches a folder whatever its mode, so a path under a file stands for a folder sh cannot
// search, whoever runs the test
test('it rejects a folder whose nearest existing path is no folder it can search', () => {
  const ctx = setupTest();
  const blocker = join(ctx.directory, 'notes.txt');

  writeFileSync(blocker, 'rye\n');

  expect(readHostSubdirs(ctx.provider, join(blocker, 'workspaces'))).rejects.toThrow(
    `atc could not list the folders under ${join(blocker, 'workspaces')}: atc cannot reach ${join(blocker, 'workspaces')}: ${blocker} is not a folder it can search`,
  );
});

test('it rejects with the host error when the folder is a file', () => {
  const ctx = setupTest();
  const notes = join(ctx.directory, 'notes.txt');

  writeFileSync(notes, 'rye\n');

  expect(readHostSubdirs(ctx.provider, notes)).rejects.toThrow(
    `atc could not list the folders under ${notes}: find: `,
  );
});

test('it lists none under a folder that is not there', async () => {
  const ctx = setupTest();

  const folders = await readHostSubdirs(ctx.provider, join(ctx.directory, 'gone'));

  expect(folders).toStrictEqual([]);
});
