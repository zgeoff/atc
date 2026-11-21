import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from '@zgeoff/testing/bin';
import { createTempDir } from '@zgeoff/testing/fs';
import { run } from '@zgeoff/testing/process';
import { buildStubRecordingATC } from './build-stub-recording-atc';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-stub-recording-atc-');

  return { directory: temporaryDirectory.path };
}

test('it records its arguments, its atc session, and its input in the log', async () => {
  const ctx = setupTest();

  const atc = createStubBin(ctx.directory, 'atc', {
    script: buildStubRecordingATC(join(ctx.directory, 'atc.log')),
  }).path;

  const result = await run([atc, 'note'], {
    input: 'half way',
    env: { ...process.env, ATC_SESSION_ID: 's-1' },
  });

  expect(result.exitCode).toBe(0);

  expect(readFileSync(join(ctx.directory, 'atc.log'), 'utf8')).toBe(
    'args:note\nsession:s-1\nstdin:half way\n',
  );
});

test('it appends each run after the runs before it', async () => {
  const ctx = setupTest();

  const atc = createStubBin(ctx.directory, 'atc', {
    script: buildStubRecordingATC(join(ctx.directory, 'atc.log')),
  }).path;

  await run([atc, 'first'], {
    input: '',
    env: { ...process.env, ATC_SESSION_ID: 's-1' },
  });

  await run([atc, 'second'], {
    input: '',
    env: { ...process.env, ATC_SESSION_ID: 's-2' },
  });

  expect(readFileSync(join(ctx.directory, 'atc.log'), 'utf8')).toBe(
    'args:first\nsession:s-1\nstdin:\nargs:second\nsession:s-2\nstdin:\n',
  );
});
