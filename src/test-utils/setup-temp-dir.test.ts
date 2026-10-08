import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { setupTempDir } from './setup-temp-dir';

test('it creates an existing directory named by the prefix', () => {
  const tmp = setupTempDir('atc-setup-temp-');

  expect(existsSync(tmp.dir)).toBeTrue();
  expect(basename(tmp.dir)).toStartWith('atc-setup-temp-');
});

test('it removes the directory on dispose', async () => {
  const tmp = setupTempDir('atc-setup-temp-');

  await tmp[Symbol.asyncDispose]();

  expect(existsSync(tmp.dir)).toBeFalse();
});

test('it creates a distinct directory per call', () => {
  const first = setupTempDir('atc-setup-temp-');
  const second = setupTempDir('atc-setup-temp-');

  expect(second.dir).not.toBe(first.dir);
});

test('it removes the directory on synchronous dispose', () => {
  const tmp = setupTempDir('atc-setup-temp-');

  tmp[Symbol.dispose]();

  expect(existsSync(tmp.dir)).toBeFalse();
});

test('it removes the directory once the test finishes without a dispose', () => {
  const tmp = setupTempDir('atc-setup-temp-');

  onTestFinished(() => {
    expect(existsSync(tmp.dir)).toBeFalse();
  });
});

test('it removes nothing once the test finishes after a dispose', () => {
  const tmp = setupTempDir('atc-setup-temp-');

  tmp[Symbol.dispose]();

  mkdirSync(tmp.dir);

  onTestFinished(() => {
    expect(existsSync(tmp.dir)).toBeTrue();
  });

  onTestFinished(() => {
    rmSync(tmp.dir, { recursive: true, force: true });
  });
});
