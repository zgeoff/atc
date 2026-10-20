import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubRecordingGit } from './build-stub-recording-git';
import { createStubBin } from './create-stub-bin';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-recording-git-');

  return { directory: temporaryDirectory.path };
}

test('it records each run and exits 0 without output', async () => {
  const ctx = setupTest();

  const git = createStubBin(
    ctx.directory,
    'git',
    buildStubRecordingGit(join(ctx.directory, 'git-ran')),
  );

  await runCommand([git, 'ls-remote', 'https://example.invalid/app.git']);

  const second = await runCommand([git, 'version']);

  expect({ exitCode: second.exitCode, stdout: second.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: '',
  });

  expect(readFileSync(join(ctx.directory, 'git-ran'), 'utf8')).toBe('ran\nran\n');
});
