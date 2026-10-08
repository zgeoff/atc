import { expect, test } from 'bun:test';
import { chmodSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  const tmp = setupTempDir('atc-stub-bin-');

  return { dir: tmp.dir };
}

test('it returns the script path under the directory', () => {
  const ctx = setupTest();

  expect(createStubBin(ctx.dir, 'gh', '#!/bin/sh\n')).toBe(join(ctx.dir, 'gh'));
});

test('it writes a script that runs as a command', async () => {
  const ctx = setupTest();
  const path = createStubBin(ctx.dir, 'gh', '#!/bin/sh\necho "fake gh $1"\n');

  const result = await runCommand([path, 'auth']);

  expect(result.stdout).toBe('fake gh auth\n');
});

test('it marks the script executable for every user', () => {
  const ctx = setupTest();
  const path = createStubBin(ctx.dir, 'gh', '#!/bin/sh\n');

  expect(statSync(path).mode & 0o777).toBe(0o755);
});

test('it creates a missing directory', async () => {
  const ctx = setupTest();
  const path = createStubBin(join(ctx.dir, 'bin', 'nested'), 'zoxide', '#!/bin/sh\necho z\n');

  const run = await runCommand([path]);

  expect(run.stdout).toBe('z\n');
});

test('it replaces an existing file and makes it executable', async () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'codex');

  writeFileSync(path, 'stale');
  chmodSync(path, 0o644);
  createStubBin(ctx.dir, 'codex', '#!/bin/sh\necho fresh\n');

  const run = await runCommand([path]);

  expect(run.stdout).toBe('fresh\n');
});
