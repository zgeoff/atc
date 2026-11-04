import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { writePTYLibrary } from './write-pty-library';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-pty-library-');

  return { directory: temporaryDirectory.path };
}

test('it points BUN_PTY_LIB at a whole copy of the library in the folder', () => {
  const ctx = setupTest();
  const env: Record<string, string | undefined> = {};

  writePTYLibrary(
    env,
    { name: 'librust_pty-sxf464jf.so', bytes: Buffer.from('library bytes') },
    ctx.directory,
  );

  const path = env['BUN_PTY_LIB'];

  invariant(path !== undefined, 'expected a copy of the library');

  expect({ directory: dirname(path), bytes: readFileSync(path, 'utf8') }).toStrictEqual({
    directory: ctx.directory,
    bytes: 'library bytes',
  });
});

test('it leaves only the copy in the folder', () => {
  const ctx = setupTest();
  const env: Record<string, string | undefined> = {};

  writePTYLibrary(
    env,
    { name: 'librust_pty-sxf464jf.so', bytes: Buffer.from('library bytes') },
    ctx.directory,
  );

  const path = env['BUN_PTY_LIB'];

  invariant(path !== undefined, 'expected a copy of the library');

  expect(readdirSync(ctx.directory)).toStrictEqual([basename(path)]);
});

test('it replaces a copy another process left in the folder', () => {
  const ctx = setupTest();
  const env: Record<string, string | undefined> = {};
  const library = { name: 'librust_pty-sxf464jf.so', bytes: Buffer.from('library bytes') };

  writePTYLibrary(env, library, ctx.directory);

  const path = env['BUN_PTY_LIB'];

  invariant(path !== undefined, 'expected a copy of the library');
  writeFileSync(path, 'library');
  writePTYLibrary(env, library, ctx.directory);

  expect(readFileSync(path, 'utf8')).toBe('library bytes');
});

test('it leaves BUN_PTY_LIB unset and no scratch file when the rename into place fails', () => {
  const ctx = setupTest();
  const env: Record<string, string | undefined> = {};
  const library = { name: 'librust_pty-sxf464jf.so', bytes: Buffer.from('library bytes') };

  writePTYLibrary(env, library, ctx.directory);

  const target = env['BUN_PTY_LIB'];

  invariant(target !== undefined, 'expected a copy of the library');
  rmSync(target);
  mkdirSync(target);
  writeFileSync(join(target, 'occupied'), '');

  Reflect.deleteProperty(env, 'BUN_PTY_LIB');

  writePTYLibrary(env, library, ctx.directory);

  expect({ env, files: readdirSync(ctx.directory) }).toStrictEqual({
    env: {},
    files: [basename(target)],
  });
});
