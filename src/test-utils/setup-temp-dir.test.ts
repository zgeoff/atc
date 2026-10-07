import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { setupTempDir } from './setup-temp-dir';

test('it creates an existing directory named by the prefix', () => {
  using tmp = setupTempDir('atc-setup-temp-');

  expect(existsSync(tmp.dir)).toBeTrue();
  expect(basename(tmp.dir)).toStartWith('atc-setup-temp-');
});

test('it removes the directory on dispose', async () => {
  await using tmp = setupTempDir('atc-setup-temp-');

  await tmp[Symbol.asyncDispose]();

  expect(existsSync(tmp.dir)).toBeFalse();
});

test('it creates a distinct directory per call', () => {
  using first = setupTempDir('atc-setup-temp-');
  using second = setupTempDir('atc-setup-temp-');

  expect(second.dir).not.toBe(first.dir);
});

test('it removes the directory on synchronous dispose', () => {
  using tmp = setupTempDir('atc-setup-temp-');

  tmp[Symbol.dispose]();

  expect(existsSync(tmp.dir)).toBeFalse();
});
