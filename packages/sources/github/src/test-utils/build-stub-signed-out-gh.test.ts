import { expect, test } from 'bun:test';
import { createStubBin } from '@atc/core/test-utils/create-stub-bin';
import { runCommand } from '@atc/core/test-utils/run-command';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { buildStubSignedOutGH } from './build-stub-signed-out-gh';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-signed-out-gh-');

  return { directory: temporaryDirectory.path };
}

test('it refuses every command with the sign-in hint and exit code 4', async () => {
  const ctx = setupTest();
  const gh = createStubBin(ctx.directory, 'gh', buildStubSignedOutGH());

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
