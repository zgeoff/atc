import { expect, test } from 'bun:test';
import { buildStubSignedOutGH } from './build-stub-signed-out-gh';
import { createStubBin } from './create-stub-bin';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  const tmp = setupTempDir('atc-stub-signed-out-gh-');

  return { dir: tmp.dir };
}

test('it refuses every command with the sign-in hint and exit code 4', async () => {
  const ctx = setupTest();
  const gh = createStubBin(ctx.dir, 'gh', buildStubSignedOutGH());

  const result = await runCommand([gh, 'repo', 'list']);

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }).toStrictEqual({
    exitCode: 4,
    stdout: '',
    stderr:
      'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n',
  });
});
