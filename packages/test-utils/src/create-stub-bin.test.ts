import { expect, test } from 'bun:test';
import { chmodSync, copyFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';
import { registerTestCleanup } from './register-test-cleanup';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-bin-');

  return { directory: temporaryDirectory.path };
}

test('it returns the script path under the directory', () => {
  const ctx = setupTest();

  expect(createStubBin(ctx.directory, 'gh', '#!/bin/sh\n')).toBe(join(ctx.directory, 'gh'));
});

test('it writes a script that runs as a command', async () => {
  const ctx = setupTest();
  const path = createStubBin(ctx.directory, 'gh', '#!/bin/sh\necho "fake gh $1"\n');

  const result = await runCommand([path, 'auth']);

  expect(result.stdout).toBe('fake gh auth\n');
});

test('it marks the script executable for every user', () => {
  const ctx = setupTest();
  const path = createStubBin(ctx.directory, 'gh', '#!/bin/sh\n');

  expect(statSync(path).mode & 0o777).toBe(0o755);
});

test('it creates a missing directory', async () => {
  const ctx = setupTest();
  const path = createStubBin(join(ctx.directory, 'bin', 'nested'), 'zoxide', '#!/bin/sh\necho z\n');

  const run = await runCommand([path]);

  expect(run.stdout).toBe('z\n');
});

test('it replaces an existing file and makes it executable', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'codex');

  writeFileSync(path, 'stale');
  chmodSync(path, 0o644);
  createStubBin(ctx.directory, 'codex', '#!/bin/sh\necho fresh\n');

  const run = await runCommand([path]);

  expect(run.stdout).toBe('fresh\n');
});

test('it replaces a file that a running process executes', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'agent');

  // A running binary holds its file against writes, as a session that a
  // test daemon's earlier boot started holds its agent.
  copyFileSync(Bun.which('sleep') ?? '/bin/sleep', path);
  chmodSync(path, 0o755);

  const running = Bun.spawn([path, '30']);

  registerTestCleanup(() => {
    running.kill();
  });

  createStubBin(ctx.directory, 'agent', '#!/bin/sh\necho fresh\n');

  const run = await runCommand([path]);

  expect(run.stdout).toBe('fresh\n');
});
