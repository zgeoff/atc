import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { createGitFixture } from '../src/test-utils/create-git-fixture';
import { runCommand } from '../src/test-utils/run-command';
import { collectBranchFiles } from './collect-branch-files';

// A bare upstream and a clone of it whose main holds one pushed commit, so
// every test starts from a repository whose history predates the branch.
async function setupTest() {
  const fixture = await createGitFixture({ prefix: 'collect-branch-files-' });

  await $`git remote set-head origin main`.env(fixture.env).cwd(fixture.work).quiet();

  return { repo: fixture.work, env: fixture.env };
}

test('it lists the files a new branch with no upstream changes', async () => {
  const ctx = await setupTest();

  await $`git switch -c feature`.env(ctx.env).cwd(ctx.repo).quiet();

  writeFileSync(join(ctx.repo, 'a.ts'), 'a');
  writeFileSync(join(ctx.repo, 'b.ts'), 'b');

  await $`git add -A`.env(ctx.env).cwd(ctx.repo).quiet();
  await $`git commit -m feature`.env(ctx.env).cwd(ctx.repo).quiet();

  const files = await collectBranchFiles({ cwd: ctx.repo, env: ctx.env });

  expect(files.toSorted()).toStrictEqual(['a.ts', 'b.ts']);
});

test('it lists only the branch files once the branch is pushed with an upstream', async () => {
  const ctx = await setupTest();

  await $`git switch -c feature`.env(ctx.env).cwd(ctx.repo).quiet();

  writeFileSync(join(ctx.repo, 'a.ts'), 'a');

  await $`git add -A`.env(ctx.env).cwd(ctx.repo).quiet();
  await $`git commit -m feature`.env(ctx.env).cwd(ctx.repo).quiet();
  await $`git push --quiet -u origin feature`.env(ctx.env).cwd(ctx.repo).quiet();

  const files = await collectBranchFiles({ cwd: ctx.repo, env: ctx.env });

  expect(files).toStrictEqual(['a.ts']);
});

test('it lists nothing when the branch has no commits of its own', async () => {
  const ctx = await setupTest();

  await $`git switch -c feature`.env(ctx.env).cwd(ctx.repo).quiet();

  const files = await collectBranchFiles({ cwd: ctx.repo, env: ctx.env });

  expect(files).toStrictEqual([]);
});

test('it leaves out a file the branch deleted', async () => {
  const ctx = await setupTest();

  await $`git switch -c feature`.env(ctx.env).cwd(ctx.repo).quiet();
  await $`git rm --quiet README.md`.env(ctx.env).cwd(ctx.repo).quiet();

  writeFileSync(join(ctx.repo, 'a.ts'), 'a');

  await $`git add -A`.env(ctx.env).cwd(ctx.repo).quiet();
  await $`git commit -m feature`.env(ctx.env).cwd(ctx.repo).quiet();

  const files = await collectBranchFiles({ cwd: ctx.repo, env: ctx.env });

  expect(files).toStrictEqual(['a.ts']);
});

test('it falls back to origin/main when origin/HEAD is unset', async () => {
  const ctx = await setupTest();

  await $`git remote set-head origin --delete`.env(ctx.env).cwd(ctx.repo).quiet();
  await $`git switch -c feature`.env(ctx.env).cwd(ctx.repo).quiet();

  writeFileSync(join(ctx.repo, 'a.ts'), 'a');

  await $`git add -A`.env(ctx.env).cwd(ctx.repo).quiet();
  await $`git commit -m feature`.env(ctx.env).cwd(ctx.repo).quiet();

  const files = await collectBranchFiles({ cwd: ctx.repo, env: ctx.env });

  expect(files).toStrictEqual(['a.ts']);
});

test('it rejects a repository with no origin', async () => {
  const ctx = await setupTest();

  await $`git remote remove origin`.env(ctx.env).cwd(ctx.repo).quiet();

  expect(collectBranchFiles({ cwd: ctx.repo, env: ctx.env })).rejects.toThrowWithMessage(
    Error,
    /cannot find the base of this branch/,
  );
});

test('it exits non-zero with a message when run in a repository with no origin', async () => {
  const ctx = await setupTest();

  await $`git remote remove origin`.env(ctx.env).cwd(ctx.repo).quiet();

  const run = await runCommand(
    [process.execPath, join(import.meta.dir, 'collect-branch-files.ts')],
    { cwd: ctx.repo, env: ctx.env },
  );

  expect(run.exitCode).toBe(1);
  expect(run.stderr).toStartWith('collect-branch-files: cannot find the base of this branch');
});
