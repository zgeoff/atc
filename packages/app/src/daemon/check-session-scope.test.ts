import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { buildStubGH } from '../test-utils/build-stub-gh';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { createStubBin } from '../test-utils/create-stub-bin';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { checkSessionScope } from './check-session-scope';
import { LocalPTYProvider } from './local-pty-provider';

async function setupTest() {
  const fixture = await createGitFixture({ prefix: 'atc-scope-check-' });

  const bin = setupTempDir('atc-scope-check-bin-');

  return { fixture, bin: bin.dir, provider: new LocalPTYProvider() };
}

test('it records a worktree with the branch git reads from it', async () => {
  const ctx = await setupTest();

  const worktree = join(ctx.fixture.dir, 'fix-login');

  await $`git worktree add --quiet -b fix-login ${worktree}`
    .env(ctx.fixture.env)
    .cwd(ctx.fixture.work);

  const checked = await checkSessionScope(
    {
      provider: ctx.provider,
      host: 's-1',
      dir: ctx.fixture.work,
      repoURL: null,
      declared: { worktrees: [{ path: worktree }], branches: [], pullRequests: [] },
    },
    'gh',
  );

  expect(checked).toStrictEqual({
    worktrees: [{ path: worktree, branch: 'fix-login' }],
    branches: [],
    pullRequests: [],
  });
});

test('it records a detached worktree without a branch', async () => {
  const ctx = await setupTest();

  const worktree = join(ctx.fixture.dir, 'detached');

  await $`git worktree add --quiet --detach ${worktree}`.env(ctx.fixture.env).cwd(ctx.fixture.work);

  const checked = await checkSessionScope(
    {
      provider: ctx.provider,
      host: 's-1',
      dir: ctx.fixture.work,
      repoURL: null,
      declared: { worktrees: [{ path: worktree }], branches: [], pullRequests: [] },
    },
    'gh',
  );

  expect(checked.worktrees).toStrictEqual([{ path: worktree, branch: null }]);
});

test('it refuses a worktree path outside git', async () => {
  const ctx = await setupTest();

  const plain = join(ctx.fixture.dir, 'plain');

  mkdirSync(plain);

  expect(
    checkSessionScope(
      {
        provider: ctx.provider,
        host: 's-1',
        dir: ctx.fixture.work,
        repoURL: null,
        declared: {
          worktrees: [{ path: ctx.fixture.work }, { path: plain }],
          branches: [],
          pullRequests: [],
        },
      },
      'gh',
    ),
  ).rejects.toMatchObject({
    code: 'scope_invalid',
    message: `scope.worktrees[1] ${plain} is not a git worktree on the session's host`,
    data: { entry: 'scope.worktrees[1]' },
  });
});

test('it refuses a directory inside a worktree that is not its top level', async () => {
  const ctx = await setupTest();

  const inner = join(ctx.fixture.work, 'docs');

  mkdirSync(inner);

  expect(
    checkSessionScope(
      {
        provider: ctx.provider,
        host: 's-1',
        dir: ctx.fixture.work,
        repoURL: null,
        declared: { worktrees: [{ path: inner }], branches: [], pullRequests: [] },
      },
      'gh',
    ),
  ).rejects.toMatchObject({
    code: 'scope_invalid',
    message: `scope.worktrees[0] ${inner} is inside the worktree ${ctx.fixture.work}, not its top level`,
    data: { entry: 'scope.worktrees[0]' },
  });
});

test("it records a local branch in the session's directory when the entry gives no repo", async () => {
  const ctx = await setupTest();

  await $`git branch fix-login`.env(ctx.fixture.env).cwd(ctx.fixture.work);

  const checked = await checkSessionScope(
    {
      provider: ctx.provider,
      host: 's-1',
      dir: ctx.fixture.work,
      repoURL: null,
      declared: { worktrees: [], branches: [{ name: 'fix-login' }], pullRequests: [] },
    },
    'gh',
  );

  expect(checked.branches).toStrictEqual([{ name: 'fix-login', repo: ctx.fixture.work }]);
});

test('it records a branch that only the origin remote holds', async () => {
  const ctx = await setupTest();

  const repo = join(ctx.fixture.dir, 'other');

  await $`git branch release && git push --quiet origin release && git branch -D release`
    .env(ctx.fixture.env)
    .cwd(ctx.fixture.work)
    .quiet();

  await $`git clone --quiet ${ctx.fixture.upstream} ${repo}`.env(ctx.fixture.env).quiet();

  const checked = await checkSessionScope(
    {
      provider: ctx.provider,
      host: 's-1',
      dir: ctx.fixture.work,
      repoURL: null,
      declared: { worktrees: [], branches: [{ name: 'release', repo }], pullRequests: [] },
    },
    'gh',
  );

  expect(checked.branches).toStrictEqual([{ name: 'release', repo }]);
});

test('it refuses a branch the repository lacks', async () => {
  const ctx = await setupTest();

  expect(
    checkSessionScope(
      {
        provider: ctx.provider,
        host: 's-1',
        dir: ctx.fixture.work,
        repoURL: null,
        declared: {
          worktrees: [],
          branches: [{ name: 'main' }, { name: 'gone' }],
          pullRequests: [],
        },
      },
      'gh',
    ),
  ).rejects.toMatchObject({
    code: 'scope_invalid',
    message: `scope.branches[1] ${ctx.fixture.work} has no branch gone`,
    data: { entry: 'scope.branches[1]' },
  });
});

test('it refuses a branch name git does not take', async () => {
  const ctx = await setupTest();

  expect(
    checkSessionScope(
      {
        provider: ctx.provider,
        host: 's-1',
        dir: ctx.fixture.work,
        repoURL: null,
        declared: { worktrees: [], branches: [{ name: 'a..b' }], pullRequests: [] },
      },
      'gh',
    ),
  ).rejects.toMatchObject({
    code: 'scope_invalid',
    message: 'scope.branches[0] a..b is not a valid branch name',
    data: { entry: 'scope.branches[0]' },
  });
});

test('it records a pull request of the repository the entry gives', async () => {
  const ctx = await setupTest();

  const gh = createStubBin(
    ctx.bin,
    'gh',
    buildStubGH({
      replies: {
        api: {
          stdout: JSON.stringify({
            number: 42,
            html_url: 'https://github.com/me/app/pull/42',
            head: { ref: 'fix-login' },
            base: { repo: { full_name: 'me/app' } },
          }),
        },
      },
      argvFile: join(ctx.bin, 'argv'),
    }),
  );

  const checked = await checkSessionScope(
    {
      provider: ctx.provider,
      host: 's-1',
      dir: ctx.fixture.work,
      repoURL: null,
      declared: { worktrees: [], branches: [], pullRequests: [{ number: 42, repo: 'me/app' }] },
    },
    gh,
  );

  expect(checked.pullRequests).toStrictEqual([
    { repo: 'me/app', number: 42, url: 'https://github.com/me/app/pull/42', branch: 'fix-login' },
  ]);

  const argv = await Bun.file(join(ctx.bin, 'argv')).text();

  expect(argv).toBe('api repos/me/app/pulls/42\n');
});

test("it takes a pull request's repository from the workspace's GitHub URL when the entry gives none", async () => {
  const ctx = await setupTest();

  const gh = createStubBin(
    ctx.bin,
    'gh',
    buildStubGH({
      replies: {
        api: {
          stdout: JSON.stringify({
            number: 9,
            html_url: 'https://github.com/me/app/pull/9',
            head: { ref: 'docs' },
            base: { repo: { full_name: 'me/app' } },
          }),
        },
      },
    }),
  );

  const checked = await checkSessionScope(
    {
      provider: ctx.provider,
      host: 's-1',
      dir: ctx.fixture.work,
      repoURL: 'https://github.com/me/app.git',
      declared: { worktrees: [], branches: [], pullRequests: [{ number: 9 }] },
    },
    gh,
  );

  expect(checked.pullRequests).toStrictEqual([
    { repo: 'me/app', number: 9, url: 'https://github.com/me/app/pull/9', branch: 'docs' },
  ]);
});

test('it refuses a pull request whose base is another repository', async () => {
  const ctx = await setupTest();

  const gh = createStubBin(
    ctx.bin,
    'gh',
    buildStubGH({
      replies: {
        api: {
          stdout: JSON.stringify({
            number: 42,
            html_url: 'https://github.com/upstream/app/pull/42',
            head: { ref: 'fix-login' },
            base: { repo: { full_name: 'upstream/app' } },
          }),
        },
      },
    }),
  );

  expect(
    checkSessionScope(
      {
        provider: ctx.provider,
        host: 's-1',
        dir: ctx.fixture.work,
        repoURL: null,
        declared: { worktrees: [], branches: [], pullRequests: [{ number: 42, repo: 'me/app' }] },
      },
      gh,
    ),
  ).rejects.toMatchObject({
    code: 'scope_invalid',
    message: 'scope.pullRequests[0] pull request #42 belongs to upstream/app, not me/app',
    data: { entry: 'scope.pullRequests[0]' },
  });
});

test('it refuses a pull request gh cannot find', async () => {
  const ctx = await setupTest();

  const gh = createStubBin(
    ctx.bin,
    'gh',
    buildStubGH({
      replies: { api: { stderr: 'gh: Not Found (HTTP 404)\n', exitCode: 1 } },
    }),
  );

  expect(
    checkSessionScope(
      {
        provider: ctx.provider,
        host: 's-1',
        dir: ctx.fixture.work,
        repoURL: null,
        declared: { worktrees: [], branches: [], pullRequests: [{ number: 404, repo: 'me/app' }] },
      },
      gh,
    ),
  ).rejects.toMatchObject({
    code: 'scope_invalid',
    message: 'scope.pullRequests[0] me/app has no pull request #404',
    data: { entry: 'scope.pullRequests[0]' },
  });
});

test("it refuses a pull request without a repo when the session's origin is not on GitHub", async () => {
  const ctx = await setupTest();

  expect(
    checkSessionScope(
      {
        provider: ctx.provider,
        host: 's-1',
        dir: ctx.fixture.work,
        repoURL: null,
        declared: { worktrees: [], branches: [], pullRequests: [{ number: 1 }] },
      },
      'gh',
    ),
  ).rejects.toMatchObject({
    code: 'scope_invalid',
    message: "scope.pullRequests[0] needs a repo: the workspace's origin is not on GitHub",
    data: { entry: 'scope.pullRequests[0]' },
  });
});

test('it refuses a pull request when gh is not installed', async () => {
  const ctx = await setupTest();

  expect(
    checkSessionScope(
      {
        provider: ctx.provider,
        host: 's-1',
        dir: ctx.fixture.work,
        repoURL: null,
        declared: { worktrees: [], branches: [], pullRequests: [{ number: 1, repo: 'me/app' }] },
      },
      join(ctx.bin, 'missing-gh'),
    ),
  ).rejects.toMatchObject({
    code: 'scope_invalid',
    message: 'scope.pullRequests[0] cannot be checked: gh is not installed on the daemon host',
    data: { entry: 'scope.pullRequests[0]' },
  });
});
