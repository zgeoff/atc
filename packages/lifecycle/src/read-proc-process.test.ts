import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { readProcProcess } from './read-proc-process';

// A temp directory that stands in for `/proc`.
function setupTest() {
  const procRoot = setupTempDir('read-proc-process-').dir;

  return { procRoot };
}

test('it reads the arguments and the environment of a process', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'atc\0daemon\0--listen=127.0.0.1:1\0');
  writeFileSync(join(ctx.procRoot, '42', 'environ'), 'HOME=/home/u\0EMPTY=\0A=b=c\0');

  expect(readProcProcess(ctx.procRoot, 42)).toStrictEqual({
    args: ['atc', 'daemon', '--listen=127.0.0.1:1'],
    env: { HOME: '/home/u', EMPTY: '', A: 'b=c' },
  });
});

test('it reads null for a process without an entry', () => {
  const ctx = setupTest();

  expect(readProcProcess(ctx.procRoot, 42)).toBeNull();
});

test('it reads null for an entry that lacks its environment', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'atc\0daemon\0');

  expect(readProcProcess(ctx.procRoot, 42)).toBeNull();
});
