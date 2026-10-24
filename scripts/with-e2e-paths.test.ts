import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand, setupTempDir } from '@atc/test-utils';

// A temp directory standing in for a repo root, with one suite of each kind
// under e2e/.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-with-e2e-paths-');

  mkdirSync(join(temporaryDirectory.path, 'e2e'));

  for (const name of ['daemon-boot', 'gateway-serve', 'tui-quit']) {
    writeFileSync(join(temporaryDirectory.path, 'e2e', `${name}.test.ts`), '');
  }

  return { directory: temporaryDirectory.path };
}

test('it runs the command on the binary smoke suites when no path follows', async () => {
  const ctx = setupTest();

  const run = await runCommand(
    ['bash', join(import.meta.dir, 'with-e2e-paths.sh'), 'echo', '--timeout', '15000', '--'],
    { cwd: ctx.directory },
  );

  expect({ exitCode: run.exitCode, stdout: run.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: '--timeout 15000 e2e/daemon-boot.test.ts e2e/gateway-serve.test.ts\n',
  });
});

test('it keeps the flags that follow and adds the binary smoke suites', async () => {
  const ctx = setupTest();

  const run = await runCommand(
    ['bash', join(import.meta.dir, 'with-e2e-paths.sh'), 'echo', '--', '--bail', '-t', 'attach'],
    { cwd: ctx.directory },
  );

  expect({ exitCode: run.exitCode, stdout: run.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: '--bail -t attach e2e/daemon-boot.test.ts e2e/gateway-serve.test.ts\n',
  });
});

test('it keeps a path filter that follows without adding the binary smoke suites', async () => {
  const ctx = setupTest();

  const run = await runCommand(
    ['bash', join(import.meta.dir, 'with-e2e-paths.sh'), 'echo', '--', 'e2e/daemon-'],
    { cwd: ctx.directory },
  );

  expect({ exitCode: run.exitCode, stdout: run.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: 'e2e/daemon-\n',
  });
});

test('it adds the binary smoke suites when every word that follows is a flag or its value', async () => {
  const ctx = setupTest();

  const run = await runCommand(
    [
      'bash',
      join(import.meta.dir, 'with-e2e-paths.sh'),
      'echo',
      '--',
      '--reporter',
      'junit',
      '--reporter-outfile',
      '/tmp/e2e.xml',
      '--timeout=9000',
    ],
    { cwd: ctx.directory },
  );

  expect({ exitCode: run.exitCode, stdout: run.stdout }).toStrictEqual({
    exitCode: 0,
    stdout:
      '--reporter junit --reporter-outfile /tmp/e2e.xml --timeout=9000 e2e/daemon-boot.test.ts e2e/gateway-serve.test.ts\n',
  });
});

test('it runs the command on the paths that follow', async () => {
  const ctx = setupTest();

  const run = await runCommand(
    ['bash', join(import.meta.dir, 'with-e2e-paths.sh'), 'echo', '--', 'e2e/tui-quit.test.ts'],
    { cwd: ctx.directory },
  );

  expect({ exitCode: run.exitCode, stdout: run.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: 'e2e/tui-quit.test.ts\n',
  });
});
