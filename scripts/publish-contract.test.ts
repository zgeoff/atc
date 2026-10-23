import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin, runCommand, setupTempDir } from '@atc/test-utils';

function setupTest() {
  const temporaryDirectory = setupTempDir('publish-contract-');

  return { directory: temporaryDirectory.path };
}

test.each([
  ['an option it does not know', ['--tag', 'next']],
  ['help', ['--help']],
  ['a positional', ['--dry-run', 'extra']],
])('it refuses %s before it packs or publishes', async (_label, args) => {
  const ctx = setupTest();

  createStubBin(
    join(ctx.directory, 'bin'),
    'npm',
    `#!/bin/sh\necho "$@" >> '${join(ctx.directory, 'npm.log')}'\n`,
  );

  const published = await runCommand(
    ['bash', join(import.meta.dir, 'publish-contract.sh'), ...args],
    { env: { ...process.env, PATH: `${join(ctx.directory, 'bin')}:${process.env['PATH']}` } },
  );

  expect(published.exitCode).toBe(2);
  expect(published.stderr).toInclude('usage: publish-contract.sh [--dry-run]');
  expect(existsSync(join(ctx.directory, 'npm.log'))).toBeFalse();
});
