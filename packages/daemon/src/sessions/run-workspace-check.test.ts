import { expect, test } from 'bun:test';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitFixture, runLocalCommand, setupTempDir } from '@atc/test-utils';
import { $ } from 'bun';
import { runWorkspaceCheck } from './run-workspace-check';

async function setupTest() {
  const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

  return {
    work: git.work,
    sha: git.sha,
    env: git.env,
    directory: git.directory,
    provider: { runCommand: runLocalCommand },
  };
}

test('it finds nothing in a clean checkout whose commits are all pushed', async () => {
  const ctx = await setupTest();

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: ctx.work,
    sha: ctx.sha,
  });

  expect(check).toStrictEqual({ kind: 'checked', path: realpathSync(ctx.work), findings: [] });
});

test('it counts each uncommitted and untracked path', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.work, 'README.md'), 'hello, edited\n');
  mkdirSync(join(ctx.work, 'notes'));
  writeFileSync(join(ctx.work, 'notes', 'todo.md'), '- ship it\n');

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: ctx.work,
    sha: ctx.sha,
  });

  expect(check).toStrictEqual({
    kind: 'checked',
    path: realpathSync(ctx.work),
    findings: ['2 uncommitted or untracked paths'],
  });
});

test('it finds nothing in an ignored file', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.work, '.git', 'info'));
  writeFileSync(join(ctx.work, '.git', 'info', 'exclude'), 'node_modules/\n');
  mkdirSync(join(ctx.work, 'node_modules'));
  writeFileSync(join(ctx.work, 'node_modules', 'index.js'), 'export {};\n');

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: ctx.work,
    sha: ctx.sha,
  });

  expect(check).toStrictEqual({ kind: 'checked', path: realpathSync(ctx.work), findings: [] });
});

test('it counts each stash', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.work, 'README.md'), 'hello, stashed\n');

  await $`git stash --quiet`.env(ctx.env).cwd(ctx.work).quiet();

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: ctx.work,
    sha: ctx.sha,
  });

  expect(check).toStrictEqual({
    kind: 'checked',
    path: realpathSync(ctx.work),
    findings: ['1 stash'],
  });
});

test('it counts the commits on each local branch that no remote-tracking ref holds', async () => {
  const ctx = await setupTest();

  await $`git switch --quiet -c fix-login`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git commit --quiet --allow-empty -m one`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git commit --quiet --allow-empty -m two`.env(ctx.env).cwd(ctx.work).quiet();

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: ctx.work,
    sha: ctx.sha,
  });

  expect(check).toStrictEqual({
    kind: 'checked',
    path: realpathSync(ctx.work),
    findings: ['2 unpushed commits on fix-login'],
  });
});

test('it counts a commit made on a detached HEAD that no branch or remote holds', async () => {
  const ctx = await setupTest();

  await $`git switch --quiet --detach`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git commit --quiet --allow-empty -m loose`.env(ctx.env).cwd(ctx.work).quiet();

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: ctx.work,
    sha: ctx.sha,
  });

  expect(check).toStrictEqual({
    kind: 'checked',
    path: realpathSync(ctx.work),
    findings: ['1 unpushed commit on a detached HEAD'],
  });
});

test('it counts a linked worktree, whose own work the other checks never see', async () => {
  const ctx = await setupTest();

  const linked = join(ctx.directory, 'shop-hotfix');

  await $`git worktree add --quiet --detach ${linked}`.env(ctx.env).cwd(ctx.work).quiet();

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: ctx.work,
    sha: ctx.sha,
  });

  expect(check).toStrictEqual({
    kind: 'checked',
    path: realpathSync(ctx.work),
    findings: ['1 linked worktree'],
  });
});

test('it leaves out a linked worktree whose folder is gone', async () => {
  const ctx = await setupTest();

  const linked = join(ctx.directory, 'shop-hotfix');

  await $`git worktree add --quiet --detach ${linked}`.env(ctx.env).cwd(ctx.work).quiet();
  await $`rm -rf ${linked}`.quiet();

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: ctx.work,
    sha: ctx.sha,
  });

  expect(check).toStrictEqual({ kind: 'checked', path: realpathSync(ctx.work), findings: [] });
});

test('it counts a committed submodule, whose own work the other checks never see', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.work, 'vendor', 'pricing'), { recursive: true });

  await $`git update-index --add --cacheinfo 160000,${ctx.sha},vendor/pricing`
    .env(ctx.env)
    .cwd(ctx.work)
    .quiet();

  await $`git commit --quiet -m vendor`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git push --quiet origin main`.env(ctx.env).cwd(ctx.work).quiet();

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: ctx.work,
    sha: ctx.sha,
  });

  expect(check).toStrictEqual({
    kind: 'checked',
    path: realpathSync(ctx.work),
    findings: ['1 submodule'],
  });
});

test('it checks a folder a symlink leads to, and reports that folder', async () => {
  const ctx = await setupTest();

  const alias = join(ctx.directory, 'alias');

  symlinkSync(ctx.work, alias);

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: alias,
    sha: ctx.sha,
  });

  expect(check).toStrictEqual({ kind: 'checked', path: realpathSync(ctx.work), findings: [] });
});

test('it reports a folder that is gone as missing', async () => {
  const ctx = await setupTest();

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: join(ctx.directory, 'removed-by-hand'),
    sha: ctx.sha,
  });

  expect(check).toStrictEqual({ kind: 'missing' });
});

test('it reports a folder that is not a git checkout as foreign', () => {
  const temporaryDirectory = setupTempDir('atc-workspace-check-plain-');

  expect(
    runWorkspaceCheck({
      provider: { runCommand: runLocalCommand },
      host: null,
      directory: temporaryDirectory.path,
      sha: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    }),
  ).resolves.toStrictEqual({ kind: 'foreign' });
});

test('it reports a folder inside a checkout as foreign', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.work, 'docs'));

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: join(ctx.work, 'docs'),
    sha: ctx.sha,
  });

  expect(check).toStrictEqual({ kind: 'foreign' });
});

test('it reports a checkout that lacks the pinned commit as foreign', async () => {
  const ctx = await setupTest();

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: ctx.work,
    sha: 'c0ffee0c0ffee0c0ffee0c0ffee0c0ffee0c0ffe',
  });

  expect(check).toStrictEqual({ kind: 'foreign' });
});

test('it reports a host that does not answer as unchecked', () => {
  expect(
    runWorkspaceCheck({
      provider: { runCommand: () => Promise.reject(new Error('box-7 is unreachable')) },
      host: 'box-7',
      directory: '/home/dev/work/shop-main',
      sha: 'c0ffee0c0ffee0c0ffee0c0ffee0c0ffee0c0ffe',
    }),
  ).resolves.toStrictEqual({ kind: 'unchecked', reason: 'host did not answer' });
});

test("it reports a git failure as unchecked, with git's first line of error", () => {
  expect(
    runWorkspaceCheck({
      provider: {
        runCommand: () =>
          Promise.resolve({
            exitCode: 82,
            stdout: '',
            stderr: 'fatal: unable to read tree\nmore detail\n',
          }),
      },
      host: null,
      directory: '/srv/work/shop-main',
      sha: 'c0ffee0c0ffee0c0ffee0c0ffee0c0ffee0c0ffe',
    }),
  ).resolves.toStrictEqual({
    kind: 'unchecked',
    reason: 'git failed: fatal: unable to read tree',
  });
});

test('it runs the check on the host it is given', async () => {
  const commands: { readonly host?: string; readonly cwd: string }[] = [];

  await runWorkspaceCheck({
    provider: {
      runCommand: (spec) => {
        commands.push({ cwd: spec.cwd, ...(spec.host === undefined ? {} : { host: spec.host }) });

        return Promise.resolve({ exitCode: 80, stdout: '', stderr: '' });
      },
    },
    host: 'box-7',
    directory: '/home/dev/work/shop-main',
    sha: 'c0ffee0c0ffee0c0ffee0c0ffee0c0ffee0c0ffe',
  });

  expect(commands).toStrictEqual([{ cwd: '/', host: 'box-7' }]);
});
