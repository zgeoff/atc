import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from '@zgeoff/testing/bin';
import { createTempDir } from '@zgeoff/testing/fs';
import { run } from '@zgeoff/testing/process';
import { buildStubRecordingGit } from './build-stub-recording-git';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-stub-recording-git-');

  return { directory: temporaryDirectory.path };
}

test('it records each run and exits 0 without output', async () => {
  const ctx = setupTest();

  const git = createStubBin(ctx.directory, 'git', {
    script: buildStubRecordingGit(join(ctx.directory, 'git-ran')),
  }).path;

  await run([git, 'ls-remote', 'https://example.invalid/app.git']);

  const second = await run([git, 'version']);

  expect({ exitCode: second.exitCode, stdout: second.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: '',
  });

  expect(readFileSync(join(ctx.directory, 'git-ran'), 'utf8')).toBe('ran\nran\n');
});
