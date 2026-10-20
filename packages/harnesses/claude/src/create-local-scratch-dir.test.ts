import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toSessionID } from '@atc/core';
import { setupTempDir } from '@atc/test-utils';
import { createLocalScratchDir } from './create-local-scratch-dir';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-scratch-');

  return { directory: temporaryDirectory.path };
}

test("it creates the session's scratch folder under its own folder, readable by its owner alone", () => {
  const ctx = setupTest();
  const scratch = createLocalScratchDir(toSessionID('s1'), ctx.directory);

  expect(scratch).toBe(join(ctx.directory, 'sessions', 's1', 'scratch'));
  expect(statSync(scratch).mode & 0o777).toBe(0o700);
});

test('it keeps what an earlier launch left in the scratch folder', () => {
  const ctx = setupTest();
  const first = createLocalScratchDir(toSessionID('s1'), ctx.directory);

  writeFileSync(join(first, 'notes.md'), 'kept');

  const scratch = createLocalScratchDir(toSessionID('s1'), ctx.directory);

  expect(readFileSync(join(scratch, 'notes.md'), 'utf8')).toBe('kept');
});

test('it takes an existing scratch folder back to its owner alone', () => {
  const ctx = setupTest();
  const existing = join(ctx.directory, 'sessions', 's1', 'scratch');

  mkdirSync(existing, { recursive: true });
  chmodSync(existing, 0o755);

  const scratch = createLocalScratchDir(toSessionID('s1'), ctx.directory);

  expect(statSync(scratch).mode & 0o777).toBe(0o700);
});
