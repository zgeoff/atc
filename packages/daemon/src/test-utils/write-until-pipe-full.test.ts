import { expect, onTestFinished, test } from 'bun:test';
import { closeSync, constants, openSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from '@zgeoff/testing/fs';
import { run } from '@zgeoff/testing/process';
import { writeUntilPipeFull } from './write-until-pipe-full';

async function setupTest() {
  const temporaryDirectory = createTempDir('atc-write-until-pipe-full-');
  const fifoPath = join(temporaryDirectory.path, 'pipe');

  await run(['mkfifo', fifoPath]);

  const readEnd = openSync(fifoPath, constants.O_RDONLY | constants.O_NONBLOCK);

  onTestFinished(() => {
    closeSync(readEnd);
  });

  return { fifoPath, readEnd };
}

test('it fills the pipe until it takes not one more byte', async () => {
  const ctx = await setupTest();

  writeUntilPipeFull(ctx.fifoPath);

  const writeEnd = openSync(ctx.fifoPath, constants.O_WRONLY | constants.O_NONBLOCK);

  onTestFinished(() => {
    closeSync(writeEnd);
  });

  expect(() => writeSync(writeEnd, 'x')).toThrow(/EAGAIN/u);
});

test('it returns how many bytes the reader then finds in the pipe', async () => {
  const ctx = await setupTest();

  const written = writeUntilPipeFull(ctx.fifoPath);

  expect(readSync(ctx.readEnd, Buffer.alloc(written + 1))).toBe(written);
});
