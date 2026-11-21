import { expect, test } from 'bun:test';
import { createStubBin } from '@zgeoff/testing/bin';
import { createTempDir } from '@zgeoff/testing/fs';
import { run } from '@zgeoff/testing/process';
import { buildStubSignedOutGH } from './build-stub-signed-out-gh';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-stub-signed-out-gh-');

  return { directory: temporaryDirectory.path };
}

test('it refuses every command with the sign-in hint and exit code 4', async () => {
  const ctx = setupTest();
  const gh = createStubBin(ctx.directory, 'gh', { script: buildStubSignedOutGH() }).path;

  const result = await run([gh, 'repo', 'list']);

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
