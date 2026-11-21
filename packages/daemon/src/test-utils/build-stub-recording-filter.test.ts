import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from '@zgeoff/testing/bin';
import { createTempDir } from '@zgeoff/testing/fs';
import { run } from '@zgeoff/testing/process';
import { buildStubRecordingFilter } from './build-stub-recording-filter';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-stub-recording-filter-');

  return { directory: temporaryDirectory.path };
}

test('it records each run and passes its input through unchanged', async () => {
  const ctx = setupTest();

  const filter = createStubBin(ctx.directory, 'trap', {
    script: buildStubRecordingFilter(join(ctx.directory, 'filter-ran')),
  }).path;

  await run([filter], { input: 'first\n' });

  const second = await run([filter], { input: 'hello\n' });

  expect({ exitCode: second.exitCode, stdout: second.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: 'hello\n',
  });

  expect(readFileSync(join(ctx.directory, 'filter-ran'), 'utf8')).toBe('ran\nran\n');
});
