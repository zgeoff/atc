import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin, runCommand, setupTempDir } from '@atc/test-utils';
import { runTitleLint } from './run-title-lint';

function setupTest() {
  const temporaryDirectory = setupTempDir('run-title-lint-');
  const repoRoot = join(temporaryDirectory.path, 'repo');

  mkdirSync(repoRoot);

  return {
    root: temporaryDirectory.path,
    repoRoot,
    installFolder: join(temporaryDirectory.path, 'runner-temp', 'title-lint'),
    binFolder: join(temporaryDirectory.path, 'bin'),
    received: join(temporaryDirectory.path, 'received'),
  };
}

test("it installs the catalog's commitlint behind the checkout's bunfig and lints the title on stdin", async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.repoRoot, 'package.json'),
    JSON.stringify({ workspaces: { catalog: { '@commitlint/cli': '21.2.4' } } }),
  );

  writeFileSync(join(ctx.repoRoot, 'bunfig.toml'), 'minimumReleaseAge = 604800\n');

  const commitlint = createStubBin(
    join(ctx.root, 'stubs'),
    'commitlint',
    `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" >> '${ctx.received}'\ncat >> '${ctx.received}'\nexit 3\n`,
  );

  createStubBin(
    ctx.binFolder,
    'bun',
    `#!/bin/sh\nprintf '%s\\n' "$*" > '${ctx.received}'\ncat bunfig.toml >> '${ctx.received}'\nmkdir -p node_modules/.bin\ncp '${commitlint}' node_modules/.bin/commitlint\n`,
  );

  const exitCode = await runTitleLint({
    title: 'feat: add a $(touch pwned) title',
    repoRoot: ctx.repoRoot,
    installFolder: ctx.installFolder,
    env: { ...process.env, PATH: `${ctx.binFolder}:${process.env['PATH'] ?? ''}` },
  });

  expect(exitCode).toBe(3);

  expect(readFileSync(ctx.received, 'utf8')).toBe(
    [
      'add --exact @commitlint/cli@21.2.4',
      'minimumReleaseAge = 604800',
      ctx.repoRoot,
      '--verbose',
      'feat: add a $(touch pwned) title',
      '',
    ].join('\n'),
  );
});

test('it answers the exit code of a failed install', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.repoRoot, 'package.json'),
    JSON.stringify({ workspaces: { catalog: { '@commitlint/cli': '21.2.4' } } }),
  );

  writeFileSync(join(ctx.repoRoot, 'bunfig.toml'), 'minimumReleaseAge = 604800\n');
  createStubBin(ctx.binFolder, 'bun', '#!/bin/sh\nexit 5\n');

  const exitCode = await runTitleLint({
    title: 'feat: add a title',
    repoRoot: ctx.repoRoot,
    installFolder: ctx.installFolder,
    env: { ...process.env, PATH: `${ctx.binFolder}:${process.env['PATH'] ?? ''}` },
  });

  expect(exitCode).toBe(5);
});

test('it rejects a checkout whose root catalog has no commitlint', () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.repoRoot, 'package.json'),
    JSON.stringify({ workspaces: { catalog: { oxlint: '1.2.3' } } }),
  );

  writeFileSync(join(ctx.repoRoot, 'bunfig.toml'), 'minimumReleaseAge = 604800\n');

  expect(
    runTitleLint({
      title: 'feat: add a title',
      repoRoot: ctx.repoRoot,
      installFolder: ctx.installFolder,
      env: process.env,
    }),
  ).rejects.toThrowWithMessage(TypeError, 'the root catalog has no version of @commitlint/cli');
});

test('it lints the TITLE variable with a commitlint it installs under RUNNER_TEMP and exits with its status', async () => {
  const ctx = setupTest();

  const commitlint = createStubBin(
    join(ctx.root, 'stubs'),
    'commitlint',
    `#!/bin/sh\nprintf 'refused: '\ncat\nexit 1\n`,
  );

  createStubBin(
    ctx.binFolder,
    'bun',
    `#!/bin/sh\nmkdir -p node_modules/.bin\ncp '${commitlint}' node_modules/.bin/commitlint\n`,
  );

  const lint = await runCommand([process.execPath, join(import.meta.dir, 'run-title-lint.ts')], {
    cwd: ctx.root,
    env: {
      ...process.env,
      PATH: `${ctx.binFolder}:${process.env['PATH'] ?? ''}`,
      RUNNER_TEMP: join(ctx.root, 'runner-temp'),
      TITLE: 'Bad title',
    },
  });

  expect({ exitCode: lint.exitCode, stdout: lint.stdout, stderr: lint.stderr }).toStrictEqual({
    exitCode: 1,
    stdout: 'refused: Bad title\n',
    stderr: '',
  });
});

test('it exits 2 with no install when RUNNER_TEMP is not set', async () => {
  const ctx = setupTest();

  const lint = await runCommand([process.execPath, join(import.meta.dir, 'run-title-lint.ts')], {
    cwd: ctx.root,
    env: { ...process.env, RUNNER_TEMP: '', TITLE: 'feat: add a title' },
  });

  expect({ exitCode: lint.exitCode, stdout: lint.stdout, stderr: lint.stderr }).toStrictEqual({
    exitCode: 2,
    stdout: '',
    stderr: 'title-lint: RUNNER_TEMP names no folder to install commitlint in\n',
  });
});
