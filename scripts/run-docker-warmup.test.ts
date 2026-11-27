import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createTempDir } from '@zgeoff/testing/fs';
import { runDockerWarmup } from './run-docker-warmup';

function setupTest() {
  const temporaryDirectory = createTempDir('run-docker-warmup-');
  const lines: string[] = [];

  const write = (line: string): void => {
    lines.push(line);
  };

  return { workDir: temporaryDirectory.path, lines, write };
}

test('it refuses an atc binary path that holds no file, before it starts docker', () => {
  const ctx = setupTest();

  const warming = runDockerWarmup({
    atcBinary: join(ctx.workDir, 'atc-linux-x64'),
    workDir: ctx.workDir,
    write: ctx.write,
  });

  expect(warming).rejects.toThrow(/no atc binary/u);
  expect(ctx.lines).toStrictEqual([]);
});

test('it refuses a work folder that is not an absolute path, before it starts docker', () => {
  const ctx = setupTest();
  const warming = runDockerWarmup({ atcBinary: '/usr/bin/env', workDir: '', write: ctx.write });

  expect(warming).rejects.toThrow(/not an absolute path/u);
  expect(ctx.lines).toStrictEqual([]);
});
