import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { setupTempDir } from './setup-temp-dir';

test('it creates an existing directory named by the prefix', () => {
  const temporaryDirectory = setupTempDir('atc-setup-temp-');

  expect(existsSync(temporaryDirectory.path)).toBeTrue();
  expect(basename(temporaryDirectory.path)).toStartWith('atc-setup-temp-');
});

test('it creates a distinct directory per call', () => {
  const first = setupTempDir('atc-setup-temp-');
  const second = setupTempDir('atc-setup-temp-');

  expect(second.path).not.toBe(first.path);
});

test('it removes the directory once torn down', () => {
  const temporaryDirectory = setupTempDir('atc-setup-temp-');

  temporaryDirectory.teardown();

  expect(existsSync(temporaryDirectory.path)).toBeFalse();
});

test('it removes the directory once the test finishes without a teardown', () => {
  const temporaryDirectory = setupTempDir('atc-setup-temp-');

  onTestFinished(() => {
    expect(existsSync(temporaryDirectory.path)).toBeFalse();
  });
});

test('it removes nothing once the test finishes after a teardown', () => {
  const temporaryDirectory = setupTempDir('atc-setup-temp-');

  temporaryDirectory.teardown();

  mkdirSync(temporaryDirectory.path);

  onTestFinished(() => {
    expect(existsSync(temporaryDirectory.path)).toBeTrue();
  });

  onTestFinished(() => {
    rmSync(temporaryDirectory.path, { recursive: true, force: true });
  });
});
