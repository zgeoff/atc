import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { requirePluginDirsOnTarget } from './require-plugin-dirs-on-target';

// A tree with a folder, a file, a symlink to each, and a symlink to nothing.
function setupTest() {
  const tmp = setupTempDir('atc-plugin-dirs-');

  mkdirSync(join(tmp.dir, 'band'));
  writeFileSync(join(tmp.dir, 'notes.txt'), 'not a plugin');
  symlinkSync(join(tmp.dir, 'band'), join(tmp.dir, 'band-link'));
  symlinkSync(join(tmp.dir, 'notes.txt'), join(tmp.dir, 'notes-link'));
  symlinkSync(join(tmp.dir, 'gone'), join(tmp.dir, 'dangling-link'));

  return { dir: tmp.dir };
}

test.each([['band'], ['band-link']])('it accepts %s, which names a folder', (name) => {
  const ctx = setupTest();

  expect(() => {
    requirePluginDirsOnTarget([join(ctx.dir, name)], 'local', false);
  }).not.toThrow();
});

test.each([
  ['missing', 'does not exist'],
  ['dangling-link', 'does not exist'],
  ['notes.txt', 'is not a folder'],
  ['notes-link', 'is not a folder'],
  ['notes.txt/band', 'does not exist'],
])('it refuses %s as bad_args, naming the path', (name, reason) => {
  const ctx = setupTest();
  const dir = join(ctx.dir, name);

  expect(() => {
    requirePluginDirsOnTarget([join(ctx.dir, 'band'), dir], 'local', false);
  }).toThrow(
    expect.objectContaining({ code: 'bad_args', message: `plugin folder '${dir}' ${reason}` }),
  );
});

test('it refuses any folder on a remote target as unsupported, before it reads the disk', () => {
  expect(() => {
    requirePluginDirsOnTarget(['/nonexistent/plugins/band'], 'box', true);
  }).toThrow(
    expect.objectContaining({
      code: 'unsupported',
      message:
        "target 'box' runs the agent on another machine, so it takes no pluginDirs; the agent's config or the spawn sets them",
    }),
  );
});

test('it accepts no folders on a remote target', () => {
  expect(() => {
    requirePluginDirsOnTarget([], 'box', true);
  }).not.toThrow();
});
