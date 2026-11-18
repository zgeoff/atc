import { expect, test } from 'bun:test';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { localDigestEnv } from '../verify/constants.ts';
import { runLocalDaemon } from './run-local-daemon.ts';

// The variables with-test-home.sh exports for a run, in a temp directory.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-run-local-daemon-');

  const env = {
    ATC_TEST_HOME: temporaryDirectory.path,
    ATC_CLI_ENTRY: '/repo/cli.ts',
    ATC_GATEWAY_ENTRY: '/repo/gateway.ts',
  };

  return { env };
}

test('it refuses a process that with-test-home.sh did not start', () => {
  expect(runLocalDaemon({})).rejects.toThrow(/with-test-home\.sh/u);
});

test('it refuses a run that has no digest of the local client', () => {
  const ctx = setupTest();

  expect(runLocalDaemon(ctx.env)).rejects.toThrowWithMessage(
    Error,
    `${localDigestEnv} is unset: \`bun verify up\` sets it`,
  );
});

test('it refuses a run whose digest is empty', () => {
  const ctx = setupTest();

  expect(runLocalDaemon({ ...ctx.env, [localDigestEnv]: '' })).rejects.toThrow(
    `${localDigestEnv} is unset`,
  );
});
