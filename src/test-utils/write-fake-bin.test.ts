import { expect, test } from 'bun:test';
import { chmodSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from './setup-temp-dir';
import { writeFakeBin } from './write-fake-bin';

test('it returns the script path under the directory', () => {
  using tmp = setupTempDir('atc-fake-bin-');

  expect(writeFakeBin(tmp.dir, 'gh', '#!/bin/sh\n')).toBe(join(tmp.dir, 'gh'));
});

test('it writes a script that runs as a command', () => {
  using tmp = setupTempDir('atc-fake-bin-');

  const path = writeFakeBin(tmp.dir, 'gh', '#!/bin/sh\necho "fake gh $1"\n');
  const result = Bun.spawnSync([path, 'auth']);

  expect(result.stdout.toString()).toBe('fake gh auth\n');
});

test('it marks the script executable for every user', () => {
  using tmp = setupTempDir('atc-fake-bin-');

  const path = writeFakeBin(tmp.dir, 'gh', '#!/bin/sh\n');

  expect(statSync(path).mode & 0o777).toBe(0o755);
});

test('it creates a missing directory', () => {
  using tmp = setupTempDir('atc-fake-bin-');

  const path = writeFakeBin(join(tmp.dir, 'bin', 'nested'), 'zoxide', '#!/bin/sh\necho z\n');

  expect(Bun.spawnSync([path]).stdout.toString()).toBe('z\n');
});

test('it replaces an existing file and makes it executable', () => {
  using tmp = setupTempDir('atc-fake-bin-');

  const path = join(tmp.dir, 'codex');

  writeFileSync(path, 'stale');
  chmodSync(path, 0o644);
  writeFakeBin(tmp.dir, 'codex', '#!/bin/sh\necho fresh\n');

  expect(Bun.spawnSync([path]).stdout.toString()).toBe('fresh\n');
});
