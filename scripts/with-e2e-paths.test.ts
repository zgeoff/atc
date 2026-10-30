import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand, setupTempDir } from '@atc/test-utils';

// A temp directory standing in for a repo root, with one suite of each kind
// under e2e/ and one unit test outside it.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-with-e2e-paths-');

  mkdirSync(join(temporaryDirectory.path, 'e2e'));
  mkdirSync(join(temporaryDirectory.path, 'src'));

  for (const name of ['daemon-boot', 'gateway-serve', 'tui-quit']) {
    writeFileSync(join(temporaryDirectory.path, 'e2e', `${name}.test.ts`), '');
  }

  writeFileSync(join(temporaryDirectory.path, 'src', 'a.test.ts'), '');

  return { directory: temporaryDirectory.path };
}

test('it runs the command on the binary smoke suites when no file follows', async () => {
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

test('it runs the command on every suite but the binary smoke suites with --source-suites', async () => {
  const ctx = setupTest();

  const run = await runCommand(
    [
      'bash',
      join(import.meta.dir, 'with-e2e-paths.sh'),
      'echo',
      '--',
      '--source-suites',
      '--randomize',
    ],
    { cwd: ctx.directory },
  );

  expect({ exitCode: run.exitCode, stdout: run.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: '--randomize e2e/tui-quit.test.ts\n',
  });
});

test('it refuses --source-suites beside an e2e file', async () => {
  const ctx = setupTest();

  const run = await runCommand(
    [
      'bash',
      join(import.meta.dir, 'with-e2e-paths.sh'),
      'echo',
      '--',
      '--source-suites',
      'e2e/tui-quit.test.ts',
    ],
    { cwd: ctx.directory },
  );

  expect({ exitCode: run.exitCode, stdout: run.stdout }).toStrictEqual({
    exitCode: 2,
    stdout: '',
  });
});

test('it runs the command on the e2e files that follow', async () => {
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

test('it adds the binary smoke suites after options when no e2e file follows', async () => {
  const ctx = setupTest();

  const run = await runCommand(
    [
      'bash',
      join(import.meta.dir, 'with-e2e-paths.sh'),
      'echo',
      '--',
      '-t',
      'attaches a client',
      '--reporter-outfile',
      'e2e/results.xml',
      '--bail',
    ],
    { cwd: ctx.directory },
  );

  expect({ exitCode: run.exitCode, stdout: run.stdout }).toStrictEqual({
    exitCode: 0,
    stdout:
      '-t attaches a client --reporter-outfile e2e/results.xml --bail e2e/daemon-boot.test.ts e2e/gateway-serve.test.ts\n',
  });
});

test('it keeps options beside the e2e files that follow', async () => {
  const ctx = setupTest();

  const run = await runCommand(
    [
      'bash',
      join(import.meta.dir, 'with-e2e-paths.sh'),
      'echo',
      '--',
      'e2e/tui-quit.test.ts',
      '--test-name-pattern=quits',
    ],
    { cwd: ctx.directory },
  );

  expect({ exitCode: run.exitCode, stdout: run.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: '--test-name-pattern=quits e2e/tui-quit.test.ts\n',
  });
});

test('it keeps the order and worker options of the CI e2e run', async () => {
  const ctx = setupTest();

  const run = await runCommand(
    [
      'bash',
      join(import.meta.dir, 'with-e2e-paths.sh'),
      'echo',
      '--',
      '--parallel=4',
      '--no-isolate',
      '--randomize',
      '--seed',
      '42',
      'e2e/tui-quit.test.ts',
    ],
    { cwd: ctx.directory },
  );

  expect({ exitCode: run.exitCode, stdout: run.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: '--parallel=4 --no-isolate --randomize --seed 42 e2e/tui-quit.test.ts\n',
  });
});

test.each([
  ['an option it does not list', '--env-file'],
  ['a path filter', 'e2e/daemon-'],
  ['a test file outside e2e/', 'src/a.test.ts'],
  ['a path that climbs out of e2e/', 'e2e/../src/a.test.ts'],
])('it refuses %s and runs nothing', async (_label, argument) => {
  const ctx = setupTest();

  const run = await runCommand(
    ['bash', join(import.meta.dir, 'with-e2e-paths.sh'), 'echo', '--', argument],
    { cwd: ctx.directory },
  );

  expect({ exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr }).toStrictEqual({
    exitCode: 2,
    stdout: '',
    stderr: `with-e2e-paths: ${argument} is not an e2e test file or a supported option; pass e2e test files or --source-suites and -t, --bail, --rerun-each, --only, --todo, --randomize, --seed, --parallel, --no-isolate, --reporter, or --reporter-outfile\n`,
  });
});
