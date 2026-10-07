import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubRecordingGit } from './build-stub-recording-git';
import { createStubBin } from './create-stub-bin';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  return setupTempDir('atc-stub-recording-git-');
}

test('it records each run and exits 0 without output', () => {
  using ctx = setupTest();

  const git = createStubBin(ctx.dir, 'git', buildStubRecordingGit(join(ctx.dir, 'git-ran')));

  Bun.spawnSync([git, 'ls-remote', 'https://example.invalid/app.git']);

  const second = Bun.spawnSync([git, 'version']);

  expect({
    exitCode: second.exitCode,
    stdout: second.stdout.toString(),
    record: readFileSync(join(ctx.dir, 'git-ran'), 'utf8'),
  }).toStrictEqual({ exitCode: 0, stdout: '', record: 'ran\nran\n' });
});
