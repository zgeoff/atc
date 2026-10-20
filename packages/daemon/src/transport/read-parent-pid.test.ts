import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { readParentPID } from './read-parent-pid';

function setupTest() {
  const tmp = setupTempDir('atc-parent-pid-');

  return { procDir: tmp.dir };
}

test('it reads the parent pid after a command name that holds spaces and parentheses', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procDir, '4321'));
  writeFileSync(join(ctx.procDir, '4321', 'stat'), '4321 (odd) name (x)) S 1234 4321 4321 0 -1\n');

  expect(readParentPID(4321, ctx.procDir)).toBe(1234);
});

test('it finds no parent for a process that is gone', () => {
  const ctx = setupTest();

  expect(readParentPID(4321, ctx.procDir)).toBeNull();
});

test('it finds no parent in a stat line without a command name', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procDir, '4321'));
  writeFileSync(join(ctx.procDir, '4321', 'stat'), '4321 S 1234\n');

  expect(readParentPID(4321, ctx.procDir)).toBeNull();
});

test.skipIf(process.platform !== 'linux')(
  'it reads the parent of the running process from /proc',
  () => {
    expect(readParentPID(process.pid)).toBe(process.ppid);
  },
);
