import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitFixture } from '@atc/test-utils';
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
