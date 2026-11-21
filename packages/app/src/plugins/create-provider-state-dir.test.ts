import { expect, test } from 'bun:test';
import { chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from '@zgeoff/testing/fs';
import { createProviderStateDir } from './create-provider-state-dir';

test('it creates the provider folder owner-only', () => {
  const state = createTempDir('atc-provider-state-').path;
  const folder = createProviderStateDir(state, 'box');

  expect(folder).toBe(join(state, 'providers', 'box'));
  expect(statSync(join(state, 'providers', 'box')).mode & 0o777).toBe(0o700);
});

test('it narrows a provider folder that already exists with wider access', () => {
  const state = createTempDir('atc-provider-state-').path;

  createProviderStateDir(state, 'box');
  chmodSync(join(state, 'providers', 'box'), 0o755);
  createProviderStateDir(state, 'box');

  expect(statSync(join(state, 'providers', 'box')).mode & 0o777).toBe(0o700);
});

test('it creates nothing for a target id that leaves the providers folder', () => {
  const state = createTempDir('atc-provider-state-').path;

  expect(createProviderStateDir(state, '../escape')).toBeNull();
  expect(statSync(state).isDirectory()).toBeTrue();
});
