import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitFixture, createStubBin, runCommand, setupTempDir } from '@atc/test-utils';
import { $ } from 'bun';
import { runFormulaUpdate } from './run-formula-update';

test('it commits the formula of the checkout version to the tap and pushes it', async () => {
  const git = await createGitFixture({ prefix: 'run-formula-update-' });

  const root = join(git.directory, 'release');

  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });

  copyFileSync(
    join(import.meta.dir, 'build-formula.sh'),
    join(root, 'scripts', 'build-formula.sh'),
  );

  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '4.2.0' }));
  writeFileSync(join(root, 'dist', 'SHA256SUMS'), 'abc123  atc-darwin-arm64\n');

  await runFormulaUpdate({ root, tapURL: git.upstream, workDir: git.directory, env: git.env });

  const subject = await $`git log -1 --format=%s`.cwd(git.upstream).env(git.env).text();
  const formula = await $`git show HEAD:Formula/atc.rb`.cwd(git.upstream).env(git.env).text();

  expect(subject).toBe('atc 4.2.0\n');
  expect(formula).toInclude('releases/download/@zgeoff/atc@4.2.0');
});

test('it commits nothing to a tap whose formula is already at the checkout version', async () => {
  const git = await createGitFixture({ prefix: 'run-formula-update-' });

  const root = join(git.directory, 'release');

  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });

  copyFileSync(
    join(import.meta.dir, 'build-formula.sh'),
    join(root, 'scripts', 'build-formula.sh'),
  );

  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '4.2.0' }));
  writeFileSync(join(root, 'dist', 'SHA256SUMS'), 'abc123  atc-darwin-arm64\n');

  await runFormulaUpdate({
    root,
    tapURL: git.upstream,
    workDir: join(git.directory, 'first'),
    env: git.env,
  });

  const before = await $`git rev-parse HEAD`.cwd(git.upstream).env(git.env).text();

  await runFormulaUpdate({
    root,
    tapURL: git.upstream,
    workDir: join(git.directory, 'second'),
    env: git.env,
  });

  const after = await $`git rev-parse HEAD`.cwd(git.upstream).env(git.env).text();

  expect(after).toBe(before);
});

test('it exits 1 with the failing command status and stderr, and leaves the tap token out', async () => {
  const temporaryDirectory = setupTempDir('run-formula-update-');
  const bin = join(temporaryDirectory.path, 'bin');

  createStubBin(bin, 'git', `#!/bin/sh\necho 'fatal: repository not found' >&2\nexit 128\n`);

  writeFileSync(
    join(temporaryDirectory.path, 'package.json'),
    JSON.stringify({ version: '4.2.0' }),
  );

  const update = await runCommand(
    [process.execPath, join(import.meta.dir, 'run-formula-update.ts')],
    {
      cwd: temporaryDirectory.path,
      env: {
        ...process.env,
        GH_TOKEN: 'tap-token-for-a-test',
        TAP: 'example/homebrew-tower',
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      },
    },
  );

  expect({ exitCode: update.exitCode, stdout: update.stdout, stderr: update.stderr }).toStrictEqual(
    {
      exitCode: 1,
      stdout: '',
      stderr: 'run-formula-update: a command exited 128: fatal: repository not found\n',
    },
  );
});
