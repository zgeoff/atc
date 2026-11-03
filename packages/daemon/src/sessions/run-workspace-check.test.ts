import { expect, test } from 'bun:test';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitFixture, runLocalCommand, setupTempDir } from '@atc/test-utils';
import { $ } from 'bun';
import { runWorkspaceCheck } from './run-workspace-check';

function setupTest() {
  return { provider: { runCommand: runLocalCommand } };
}

test('it finds nothing in a clean checkout whose commits are all pushed', async () => {
  const ctx = setupTest();

  const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: git.work,
    sha: git.sha,
  });

  expect(check).toStrictEqual({ kind: 'checked', path: realpathSync(git.work), findings: [] });
});

test('it counts each uncommitted and untracked path', async () => {
  const ctx = setupTest();

  const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

  writeFileSync(join(git.work, 'README.md'), 'hello, edited\n');
  mkdirSync(join(git.work, 'notes'));
  writeFileSync(join(git.work, 'notes', 'todo.md'), '- ship it\n');

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: git.work,
    sha: git.sha,
  });

  expect(check).toStrictEqual({
    kind: 'checked',
    path: realpathSync(git.work),
    findings: ['2 uncommitted or untracked paths'],
  });
});

test.each([['--skip-worktree'], ['--assume-unchanged']])(
  'it counts a tracked path that %s hides from git status',
  async (flag) => {
    const ctx = setupTest();

    const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

    await $`git update-index ${flag} README.md`.env(git.env).cwd(git.work).quiet();

    writeFileSync(join(git.work, 'README.md'), 'hello, edited out of sight\n');

    const check = await runWorkspaceCheck({
      provider: ctx.provider,
      host: null,
      directory: git.work,
      sha: git.sha,
    });

    expect(check).toStrictEqual({
      kind: 'checked',
      path: realpathSync(git.work),
      findings: ['1 path hidden from git status'],
    });
  },
);

test('it finds nothing in an ignored file', async () => {
  const ctx = setupTest();

  const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

  mkdirSync(join(git.work, '.git', 'info'));
  writeFileSync(join(git.work, '.git', 'info', 'exclude'), 'node_modules/\n');
  mkdirSync(join(git.work, 'node_modules'));
  writeFileSync(join(git.work, 'node_modules', 'index.js'), 'export {};\n');

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: git.work,
    sha: git.sha,
  });

  expect(check).toStrictEqual({ kind: 'checked', path: realpathSync(git.work), findings: [] });
});

test('it counts each stash', async () => {
  const ctx = setupTest();

  const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

  writeFileSync(join(git.work, 'README.md'), 'hello, stashed\n');

  await $`git stash --quiet`.env(git.env).cwd(git.work).quiet();

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: git.work,
    sha: git.sha,
  });

  expect(check).toStrictEqual({
    kind: 'checked',
    path: realpathSync(git.work),
    findings: ['1 stash'],
  });
});

test('it counts the commits on each local branch that no remote-tracking ref holds', async () => {
  const ctx = setupTest();

  const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

  await $`git switch --quiet -c fix-login`.env(git.env).cwd(git.work).quiet();
  await $`git commit --quiet --allow-empty -m one`.env(git.env).cwd(git.work).quiet();
  await $`git commit --quiet --allow-empty -m two`.env(git.env).cwd(git.work).quiet();

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: git.work,
    sha: git.sha,
  });

  expect(check).toStrictEqual({
    kind: 'checked',
    path: realpathSync(git.work),
    findings: ['2 unpushed commits on fix-login'],
  });
});

test('it counts a commit made on a detached HEAD that no branch or remote holds', async () => {
  const ctx = setupTest();

  const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

  await $`git switch --quiet --detach`.env(git.env).cwd(git.work).quiet();
  await $`git commit --quiet --allow-empty -m loose`.env(git.env).cwd(git.work).quiet();

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: git.work,
    sha: git.sha,
  });

  expect(check).toStrictEqual({
    kind: 'checked',
    path: realpathSync(git.work),
    findings: ['1 unpushed commit on a detached HEAD'],
  });
});

test('it counts the commits on a local tag that no branch or remote holds', async () => {
  const ctx = setupTest();

  const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

  await $`git switch --quiet --detach`.env(git.env).cwd(git.work).quiet();
  await $`git commit --quiet --allow-empty -m tagged`.env(git.env).cwd(git.work).quiet();
  await $`git tag release-candidate`.env(git.env).cwd(git.work).quiet();
  await $`git switch --quiet -`.env(git.env).cwd(git.work).quiet();

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: git.work,
    sha: git.sha,
  });

  expect(check).toStrictEqual({
    kind: 'checked',
    path: realpathSync(git.work),
    findings: ['1 unpushed commit on tag release-candidate'],
  });
});

test('it reports a checkout with a tag on an object that is not a commit as unchecked', async () => {
  const ctx = setupTest();

  const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

  await $`git tag tree-snapshot HEAD^{tree}`.env(git.env).cwd(git.work).quiet();

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: git.work,
    sha: git.sha,
  });

  expect(check).toStrictEqual({
    kind: 'unchecked',
    reason: expect.stringMatching(/^git failed: .*refs\/tags\/tree-snapshot/u),
  });
});

test('it counts the commits on a notes ref that no remote holds', async () => {
  const ctx = setupTest();

  const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

  await $`git notes add -m ${'reviewed by the release crew'}`.env(git.env).cwd(git.work).quiet();

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: git.work,
    sha: git.sha,
  });

  expect(check).toStrictEqual({
    kind: 'checked',
    path: realpathSync(git.work),
    findings: ['1 unpushed commit on notes ref commits'],
  });
});

test('it counts a linked worktree, whose own work the other checks never see', async () => {
  const ctx = setupTest();

  const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

  const linked = join(git.directory, 'shop-hotfix');

  await $`git worktree add --quiet --detach ${linked}`.env(git.env).cwd(git.work).quiet();

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: git.work,
    sha: git.sha,
  });

  expect(check).toStrictEqual({
    kind: 'checked',
    path: realpathSync(git.work),
    findings: ['1 linked worktree'],
  });
});

test('it leaves out a linked worktree whose folder is gone', async () => {
  const ctx = setupTest();

  const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

  const linked = join(git.directory, 'shop-hotfix');

  await $`git worktree add --quiet --detach ${linked}`.env(git.env).cwd(git.work).quiet();
  await $`rm -rf ${linked}`.quiet();

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: git.work,
    sha: git.sha,
  });

  expect(check).toStrictEqual({ kind: 'checked', path: realpathSync(git.work), findings: [] });
});

test('it counts a committed submodule, whose own work the other checks never see', async () => {
  const ctx = setupTest();

  const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

  mkdirSync(join(git.work, 'vendor', 'pricing'), { recursive: true });

  await $`git update-index --add --cacheinfo 160000,${git.sha},vendor/pricing`
    .env(git.env)
    .cwd(git.work)
    .quiet();

  await $`git commit --quiet -m vendor`.env(git.env).cwd(git.work).quiet();
  await $`git push --quiet origin main`.env(git.env).cwd(git.work).quiet();

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: git.work,
    sha: git.sha,
  });

  expect(check).toStrictEqual({
    kind: 'checked',
    path: realpathSync(git.work),
    findings: ['1 submodule'],
  });
});

test('it reads every line the script prints for a checkout that holds each kind of work', async () => {
  const ctx = setupTest();

  const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

  const linked = join(git.directory, 'shop-hotfix');

  writeFileSync(join(git.work, 'README.md'), 'hello, stashed\n');

  await $`git stash --quiet`.env(git.env).cwd(git.work).quiet();
  await $`git switch --quiet -c fix-login`.env(git.env).cwd(git.work).quiet();
  await $`git commit --quiet --allow-empty -m one`.env(git.env).cwd(git.work).quiet();
  await $`git switch --quiet --detach`.env(git.env).cwd(git.work).quiet();

  mkdirSync(join(git.work, 'vendor', 'pricing'), { recursive: true });

  await $`git update-index --add --cacheinfo 160000,${git.sha},vendor/pricing`
    .env(git.env)
    .cwd(git.work)
    .quiet();

  await $`git commit --quiet -m vendor`.env(git.env).cwd(git.work).quiet();
  await $`git worktree add --quiet --detach ${linked}`.env(git.env).cwd(git.work).quiet();
  await $`git update-index --assume-unchanged README.md`.env(git.env).cwd(git.work).quiet();

  writeFileSync(join(git.work, 'README.md'), 'hello, edited out of sight\n');
  writeFileSync(join(git.work, 'notes.md'), '- ship it\n');

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: git.work,
    sha: git.sha,
  });

  expect(check).toStrictEqual({
    kind: 'checked',
    path: realpathSync(git.work),
    findings: [
      '1 uncommitted or untracked path',
      '1 path hidden from git status',
      '1 stash',
      '1 linked worktree',
      '1 submodule',
      '1 unpushed commit on fix-login',
      '2 unpushed commits on a detached HEAD',
    ],
  });
});

test('it checks a folder given with a trailing slash', async () => {
  const ctx = setupTest();

  const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: `${git.work}/`,
    sha: git.sha,
  });

  expect(check).toStrictEqual({ kind: 'checked', path: realpathSync(git.work), findings: [] });
});

test('it reports a symlink where the workspace was as foreign, even to a clean pushed checkout', async () => {
  const ctx = setupTest();

  const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

  const alias = join(git.directory, 'alias');

  symlinkSync(git.work, alias);

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: alias,
    sha: git.sha,
  });

  expect(check).toStrictEqual({ kind: 'foreign' });
});

test('it reports a folder that is gone as missing', async () => {
  const ctx = setupTest();

  const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: join(git.directory, 'removed-by-hand'),
    sha: git.sha,
  });

  expect(check).toStrictEqual({ kind: 'missing' });
});

test('it reports a folder that is not a git checkout as foreign', () => {
  const ctx = setupTest();
  const temporaryDirectory = setupTempDir('atc-workspace-check-plain-');

  expect(
    runWorkspaceCheck({
      provider: ctx.provider,
      host: null,
      directory: temporaryDirectory.path,
      sha: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    }),
  ).resolves.toStrictEqual({ kind: 'foreign' });
});

test('it reports a folder inside a checkout as foreign', async () => {
  const ctx = setupTest();

  const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

  mkdirSync(join(git.work, 'docs'));

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: join(git.work, 'docs'),
    sha: git.sha,
  });

  expect(check).toStrictEqual({ kind: 'foreign' });
});

test('it reports a checkout that lacks the pinned commit as foreign', async () => {
  const ctx = setupTest();

  const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: git.work,
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

test("it reports a checkout whose index git cannot read as unchecked, with git's first line of error", async () => {
  const ctx = setupTest();

  const git = await createGitFixture({ prefix: 'atc-workspace-check-' });

  writeFileSync(join(git.work, '.git', 'index'), 'not an index\n');

  const check = await runWorkspaceCheck({
    provider: ctx.provider,
    host: null,
    directory: git.work,
    sha: git.sha,
  });

  expect(check).toStrictEqual({
    kind: 'unchecked',
    reason: 'git failed: fatal: .git/index: index file smaller than expected',
  });
});

test('it reports an answer that lacks a count as unchecked', () => {
  expect(
    runWorkspaceCheck({
      provider: {
        runCommand: () =>
          Promise.resolve({
            exitCode: 0,
            stdout: '/srv/work/shop-main\0changes 0\nstashes 0\n',
            stderr: '',
          }),
      },
      host: null,
      directory: '/srv/work/shop-main',
      sha: 'c0ffee0c0ffee0c0ffee0c0ffee0c0ffee0c0ffe',
    }),
  ).resolves.toStrictEqual({
    kind: 'unchecked',
    reason:
      'the check printed an unknown answer: expected exactly one line at hidden; expected exactly one line at worktrees; expected exactly one line at submodules',
  });
});

test('it reports an answer with a count it does not know as unchecked', () => {
  expect(
    runWorkspaceCheck({
      provider: {
        runCommand: () =>
          Promise.resolve({
            exitCode: 0,
            stdout:
              '/srv/work/shop-main\0changes 0\nhidden 0\nstashes 0\nworktrees 0\nsubmodules 0\nrefunds 2\n',
            stderr: '',
          }),
      },
      host: null,
      directory: '/srv/work/shop-main',
      sha: 'c0ffee0c0ffee0c0ffee0c0ffee0c0ffee0c0ffe',
    }),
  ).resolves.toStrictEqual({
    kind: 'unchecked',
    reason: 'the check printed an unknown answer: Unrecognized key: "refunds"',
  });
});

test('it reports an answer whose label names an object built-in as unchecked', () => {
  expect(
    runWorkspaceCheck({
      provider: {
        runCommand: () =>
          Promise.resolve({
            exitCode: 0,
            stdout:
              '/srv/work/shop-main\0changes 0\nhidden 0\nstashes 0\nworktrees 0\nsubmodules 0\nconstructor 2\n',
            stderr: '',
          }),
      },
      host: null,
      directory: '/srv/work/shop-main',
      sha: 'c0ffee0c0ffee0c0ffee0c0ffee0c0ffee0c0ffe',
    }),
  ).resolves.toStrictEqual({
    kind: 'unchecked',
    reason: 'the check printed an unknown answer: Unrecognized key: "constructor"',
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
