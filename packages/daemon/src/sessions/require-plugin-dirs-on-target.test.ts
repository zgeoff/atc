import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { requirePluginDirsOnTarget } from './require-plugin-dirs-on-target';

function setupTest() {
  const tmp = setupTempDir('atc-plugin-dirs-');

  return { dir: tmp.dir };
}

test('it accepts a folder', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'band'));

  expect(() => {
    requirePluginDirsOnTarget([join(ctx.dir, 'band')], 'local', false);
  }).not.toThrow();
});

test('it accepts a symlink to a folder', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'band'));
  symlinkSync(join(ctx.dir, 'band'), join(ctx.dir, 'band-link'));

  expect(() => {
    requirePluginDirsOnTarget([join(ctx.dir, 'band-link')], 'local', false);
  }).not.toThrow();
});

test('it refuses a path that does not exist as bad_args, naming the path', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'band'));

  expect(() => {
    requirePluginDirsOnTarget([join(ctx.dir, 'band'), join(ctx.dir, 'missing')], 'local', false);
  }).toThrow(
    expect.objectContaining({
      code: 'bad_args',
      message: `plugin folder '${join(ctx.dir, 'missing')}' does not exist`,
    }),
  );
});

test('it refuses a symlink to nothing as a path that does not exist', () => {
  const ctx = setupTest();

  symlinkSync(join(ctx.dir, 'gone'), join(ctx.dir, 'dangling-link'));

  expect(() => {
    requirePluginDirsOnTarget([join(ctx.dir, 'dangling-link')], 'local', false);
  }).toThrow(
    expect.objectContaining({
      code: 'bad_args',
      message: `plugin folder '${join(ctx.dir, 'dangling-link')}' does not exist`,
    }),
  );
});

test('it refuses a path under a regular file as a path that does not exist', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'notes.txt'), 'not a plugin');

  expect(() => {
    requirePluginDirsOnTarget([join(ctx.dir, 'notes.txt', 'band')], 'local', false);
  }).toThrow(
    expect.objectContaining({
      code: 'bad_args',
      message: `plugin folder '${join(ctx.dir, 'notes.txt', 'band')}' does not exist`,
    }),
  );
});

test('it refuses a regular file as bad_args, naming the path', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'notes.txt'), 'not a plugin');

  expect(() => {
    requirePluginDirsOnTarget([join(ctx.dir, 'notes.txt')], 'local', false);
  }).toThrow(
    expect.objectContaining({
      code: 'bad_args',
      message: `plugin folder '${join(ctx.dir, 'notes.txt')}' is not a folder`,
    }),
  );
});

test('it refuses a symlink to a regular file as a path that is not a folder', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'notes.txt'), 'not a plugin');
  symlinkSync(join(ctx.dir, 'notes.txt'), join(ctx.dir, 'notes-link'));

  expect(() => {
    requirePluginDirsOnTarget([join(ctx.dir, 'notes-link')], 'local', false);
  }).toThrow(
    expect.objectContaining({
      code: 'bad_args',
      message: `plugin folder '${join(ctx.dir, 'notes-link')}' is not a folder`,
    }),
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
