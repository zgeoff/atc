import { expect, test } from 'bun:test';
import { buildStubSignedOutGH } from './build-stub-signed-out-gh';
import { createStubBin } from './create-stub-bin';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  return setupTempDir('atc-stub-signed-out-gh-');
}

test('it refuses every command with the sign-in hint and exit code 4', () => {
  using ctx = setupTest();

  const gh = createStubBin(ctx.dir, 'gh', buildStubSignedOutGH());
  const result = Bun.spawnSync([gh, 'repo', 'list']);

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 4, stdout: '', stderr: 'gh auth login\n' });
});
