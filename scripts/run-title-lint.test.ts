import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin, runCommand, setupTempDir } from '@atc/test-utils';
import { runTitleLint } from './run-title-lint';

test('it hands the title to commitlint on stdin and answers its exit code', async () => {
  const temporaryDirectory = setupTempDir('run-title-lint-');
  const received = join(temporaryDirectory.path, 'received');

  const commitlint = createStubBin(
    join(temporaryDirectory.path, 'bin'),
    'commitlint',
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${received}'\ncat >> '${received}'\nexit 3\n`,
  );

  const exitCode = await runTitleLint({
    title: 'feat: add a $(touch pwned) title',
    commitlint,
    env: process.env,
  });

  expect(exitCode).toBe(3);
  expect(readFileSync(received, 'utf8')).toBe('--verbose\nfeat: add a $(touch pwned) title\n');
});

test("it lints the TITLE variable with the checkout's commitlint and exits with its status", async () => {
  const temporaryDirectory = setupTempDir('run-title-lint-');

  createStubBin(
    join(temporaryDirectory.path, 'node_modules', '.bin'),
    'commitlint',
    `#!/bin/sh\nprintf 'refused: '\ncat\nexit 1\n`,
  );

  const lint = await runCommand([process.execPath, join(import.meta.dir, 'run-title-lint.ts')], {
    cwd: temporaryDirectory.path,
    env: { ...process.env, TITLE: 'Bad title' },
  });

  expect({ exitCode: lint.exitCode, stdout: lint.stdout, stderr: lint.stderr }).toStrictEqual({
    exitCode: 1,
    stdout: 'refused: Bad title\n',
    stderr: '',
  });
});
