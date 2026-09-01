import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { setupTempDir } from './setup-temp-dir';

test('it creates an existing directory named by the prefix', async () => {
  const tmp = setupTempDir('atc-setup-temp-');

  expect(existsSync(tmp.dir)).toBeTrue();
  expect(basename(tmp.dir)).toStartWith('atc-setup-temp-');

  await tmp[Symbol.asyncDispose]();
});

test('it removes the directory on dispose', async () => {
  const tmp = setupTempDir('atc-setup-temp-');

  await tmp[Symbol.asyncDispose]();

  expect(existsSync(tmp.dir)).toBeFalse();
});

test('it creates a distinct directory per call', async () => {
  const first = setupTempDir('atc-setup-temp-');
  const second = setupTempDir('atc-setup-temp-');

  expect(second.dir).not.toBe(first.dir);

  await first[Symbol.asyncDispose]();
  await second[Symbol.asyncDispose]();
});
