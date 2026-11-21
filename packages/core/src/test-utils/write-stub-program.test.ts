import { expect, test } from 'bun:test';
import { chmodSync, copyFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerTestCleanup } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';
import { run } from '@zgeoff/testing/process';
import { writeStubProgram } from './write-stub-program';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-stub-program-');

  return { directory: temporaryDirectory.path };
}

test('it returns the script path under the directory', () => {
  const ctx = setupTest();

  expect(writeStubProgram(ctx.directory, 'claude', '#!/bin/sh\n')).toBe(
    join(ctx.directory, 'claude'),
  );
});

test('it writes a script that runs as the process itself', async () => {
  const ctx = setupTest();
  const path = writeStubProgram(ctx.directory, 'claude', '#!/bin/sh\necho "fake claude $PPID"\n');

  const result = await run([path]);

  expect(result.stdout).toStartWith('fake claude ');
});

test('it marks the script executable for every user', () => {
  const ctx = setupTest();
  const path = writeStubProgram(ctx.directory, 'claude', '#!/bin/sh\n');

  expect(statSync(path).mode & 0o777).toBe(0o755);
});

test('it creates a missing directory', async () => {
  const ctx = setupTest();

  const path = writeStubProgram(
    join(ctx.directory, 'bin', 'nested'),
    'agent',
    '#!/bin/sh\necho z\n',
  );

  const result = await run([path]);

  expect(result.stdout).toBe('z\n');
});

test('it replaces an existing file and makes it executable', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'codex');

  writeFileSync(path, 'stale');
  chmodSync(path, 0o644);
  writeStubProgram(ctx.directory, 'codex', '#!/bin/sh\necho fresh\n');

  const result = await run([path]);

  expect(result.stdout).toBe('fresh\n');
});

test('it replaces a file that a running process executes', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'agent');

  // Linux refuses writes to a file that a running process executes (ETXTBSY), as when a
  // session from an earlier test daemon boot still runs the agent.
  copyFileSync(Bun.which('sleep') ?? '/bin/sleep', path);
  chmodSync(path, 0o755);

  const running = Bun.spawn([path, '30']);

  registerTestCleanup(() => {
    running.kill();
  });

  writeStubProgram(ctx.directory, 'agent', '#!/bin/sh\necho fresh\n');

  const result = await run([path]);

  expect(result.stdout).toBe('fresh\n');
});
