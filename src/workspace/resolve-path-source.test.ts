import { expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { updateEnv } from '../test-utils/update-env';
import { resolvePathSource } from './resolve-path-source';

// A work clone of a bare upstream, holding one pushed commit, for a test to
// change before it resolves the checkout.
function setupTest() {
  return createGitFixture({ prefix: 'atc-path-source-' });
}

test('it resolves a clean pushed checkout to its origin URL and HEAD', async () => {
  await using ctx = await setupTest();

  const resolved = await resolvePathSource(ctx.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: true,
    url: ctx.upstream,
    sha: ctx.sha,
    branch: 'main',
    dirty: false,
    warnings: [],
  });
});

test('it resolves a subdirectory to the checkout that holds it', async () => {
  await using ctx = await setupTest();

  await mkdir(join(ctx.work, 'nested'));

  const resolved = await resolvePathSource(join(ctx.work, 'nested'), {
    transports: ['https', 'ssh', 'file'],
  });

  expect(resolved).toStrictEqual({
    ok: true,
    url: ctx.upstream,
    sha: ctx.sha,
    branch: 'main',
    dirty: false,
    warnings: [],
  });
});

test('it strips a token from the origin URL', async () => {
  await using ctx = await setupTest();

  await $`git remote set-url origin https://x-access-token:ghp_secret@github.com/zgeoff/atc.git`
    .env(ctx.env)
    .cwd(ctx.work)
    .quiet();

  await $`git update-ref refs/remotes/origin/main HEAD`.env(ctx.env).cwd(ctx.work).quiet();

  const resolved = await resolvePathSource(ctx.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: true,
    url: 'https://github.com/zgeoff/atc.git',
    sha: ctx.sha,
    branch: 'main',
    dirty: false,
    warnings: [],
  });
});

test('it resolves a checkout with an uncommitted change to HEAD with a warning that counts it', async () => {
  await using ctx = await setupTest();

  await writeFile(join(ctx.work, 'README.md'), 'edited\n');

  const resolved = await resolvePathSource(ctx.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: true,
    url: ctx.upstream,
    sha: ctx.sha,
    branch: 'main',
    dirty: true,
    warnings: [
      `cloned commit ${ctx.sha.slice(0, 12)}; left 1 uncommitted or untracked path behind in ${ctx.work}`,
    ],
  });
});

test('it resolves a checkout with untracked files to HEAD without naming them', async () => {
  await using ctx = await setupTest();

  await writeFile(join(ctx.work, '.env'), 'TOKEN=secret\n');
  await writeFile(join(ctx.work, 'notes.txt'), 'scratch\n');

  const resolved = await resolvePathSource(ctx.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: true,
    url: ctx.upstream,
    sha: ctx.sha,
    branch: 'main',
    dirty: true,
    warnings: [
      `cloned commit ${ctx.sha.slice(0, 12)}; left 2 uncommitted or untracked paths behind in ${ctx.work}`,
    ],
  });
});

test('it counts each file inside an untracked directory', async () => {
  await using ctx = await setupTest();

  await mkdir(join(ctx.work, 'drafts'));
  await writeFile(join(ctx.work, 'drafts', 'a.txt'), 'a\n');
  await writeFile(join(ctx.work, 'drafts', 'b.txt'), 'b\n');
  await writeFile(join(ctx.work, 'drafts', 'c.txt'), 'c\n');

  const resolved = await resolvePathSource(ctx.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: true,
    url: ctx.upstream,
    sha: ctx.sha,
    branch: 'main',
    dirty: true,
    warnings: [
      `cloned commit ${ctx.sha.slice(0, 12)}; left 3 uncommitted or untracked paths behind in ${ctx.work}`,
    ],
  });
});

test('it leaves the changes of a dirty checkout as they were', async () => {
  await using ctx = await setupTest();

  await writeFile(join(ctx.work, 'README.md'), 'edited\n');
  await writeFile(join(ctx.work, 'notes.txt'), 'scratch\n');

  await $`git add notes.txt`.env(ctx.env).cwd(ctx.work).quiet();

  const before = await $`git status --porcelain`.env(ctx.env).cwd(ctx.work).text();

  await resolvePathSource(ctx.work, { transports: ['https', 'ssh', 'file'] });

  const after = await $`git status --porcelain`.env(ctx.env).cwd(ctx.work).text();
  const readme = await readFile(join(ctx.work, 'README.md'), 'utf8');
  const notes = await readFile(join(ctx.work, 'notes.txt'), 'utf8');

  expect(after).toBe(before);
  expect(readme).toBe('edited\n');
  expect(notes).toBe('scratch\n');
});

test('it refuses a checkout with an uncommitted change when dirt is refused', async () => {
  await using ctx = await setupTest();

  await writeFile(join(ctx.work, 'README.md'), 'edited\n');

  const resolved = await resolvePathSource(ctx.work, {
    allowDirty: 'refuse',
    transports: ['https', 'ssh', 'file'],
  });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'workspace_dirty',
    message: `${ctx.work} has uncommitted or untracked changes`,
  });
});

test('it refuses a checkout with an untracked file when dirt is refused', async () => {
  await using ctx = await setupTest();

  await writeFile(join(ctx.work, 'notes.txt'), 'scratch\n');

  const resolved = await resolvePathSource(ctx.work, {
    allowDirty: 'refuse',
    transports: ['https', 'ssh', 'file'],
  });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'workspace_dirty',
    message: `${ctx.work} has uncommitted or untracked changes`,
  });
});

test('it refuses a dirty checkout whose HEAD origin does not hold rather than resolve an older commit', async () => {
  await using ctx = await setupTest();

  await writeFile(join(ctx.work, 'README.md'), 'local\n');

  await $`git commit --quiet -am local`.env(ctx.env).cwd(ctx.work).quiet();

  await writeFile(join(ctx.work, 'notes.txt'), 'scratch\n');

  const sha = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  const resolved = await resolvePathSource(ctx.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'unpushed_head',
    message: `${sha} is not on origin; push it first`,
  });
});

test('it resolves a dirty checkout to HEAD with a warning when dirt is allowed', async () => {
  await using ctx = await setupTest();

  await writeFile(join(ctx.work, 'README.md'), 'edited\n');

  const resolved = await resolvePathSource(ctx.work, {
    allowDirty: 'warn',
    transports: ['https', 'ssh', 'file'],
  });

  expect(resolved).toStrictEqual({
    ok: true,
    url: ctx.upstream,
    sha: ctx.sha,
    branch: 'main',
    dirty: true,
    warnings: [
      `cloned commit ${ctx.sha.slice(0, 12)}; left 1 uncommitted or untracked path behind in ${ctx.work}`,
    ],
  });
});

test('it refuses a directory outside any git repository', async () => {
  await using ctx = await setupTest();

  await mkdir(join(ctx.dir, 'loose'));

  const resolved = await resolvePathSource(join(ctx.dir, 'loose'), {
    transports: ['https', 'ssh', 'file'],
  });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'not_a_git_repo',
    message: `${join(ctx.dir, 'loose')} is not inside a git work tree`,
  });
});

test('it refuses a path that does not exist', async () => {
  await using ctx = await setupTest();

  const resolved = await resolvePathSource(join(ctx.dir, 'missing'), {
    transports: ['https', 'ssh', 'file'],
  });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'not_a_git_repo',
    message: `${join(ctx.dir, 'missing')} is not a directory`,
  });
});

test('it refuses a repository with no commits', async () => {
  await using ctx = await setupTest();

  await $`git init --quiet --template= ${join(ctx.dir, 'empty')}`.env(ctx.env).quiet();

  const resolved = await resolvePathSource(join(ctx.dir, 'empty'), {
    transports: ['https', 'ssh', 'file'],
  });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'no_commits',
    message: `${join(ctx.dir, 'empty')} has no commit to check out`,
  });
});

test('it refuses a HEAD commit that was never pushed', async () => {
  await using ctx = await setupTest();

  await writeFile(join(ctx.work, 'README.md'), 'local only\n');

  await $`git commit --quiet -am local`.env(ctx.env).cwd(ctx.work).quiet();

  const sha = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  const resolved = await resolvePathSource(ctx.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'unpushed_head',
    message: `${sha} is not on origin; push it first`,
  });
});

test('it refuses a HEAD commit that only another remote holds', async () => {
  await using ctx = await setupTest();

  await writeFile(join(ctx.work, 'README.md'), 'fork only\n');

  await $`git commit --quiet -am fork`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git update-ref refs/remotes/fork/main HEAD`.env(ctx.env).cwd(ctx.work).quiet();

  const sha = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  const resolved = await resolvePathSource(ctx.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'unpushed_head',
    message: `${sha} is not on origin; push it first`,
  });
});

test('it accepts a pushed HEAD whose remote-tracking ref was never fetched', async () => {
  await using ctx = await setupTest();

  await writeFile(join(ctx.work, 'README.md'), 'pushed elsewhere\n');

  await $`git commit --quiet -am pushed`.env(ctx.env).cwd(ctx.work).quiet();

  const sha = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  await $`git push --quiet ${ctx.upstream} HEAD:refs/heads/other`
    .env(ctx.env)
    .cwd(ctx.work)
    .quiet();

  const resolved = await resolvePathSource(ctx.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: true,
    url: ctx.upstream,
    sha,
    branch: 'main',
    dirty: false,
    warnings: [],
  });
});

test('it refuses a checkout with no origin remote', async () => {
  await using ctx = await setupTest();

  await $`git remote remove origin`.env(ctx.env).cwd(ctx.work).quiet();

  const resolved = await resolvePathSource(ctx.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'no_origin',
    message: `${ctx.work} has no origin remote`,
  });
});

test('it refuses an origin URL it cannot read as a repository URL', async () => {
  await using ctx = await setupTest();

  await $`git remote set-url origin 'not a url'`.env(ctx.env).cwd(ctx.work).quiet();

  const resolved = await resolvePathSource(ctx.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'invalid_git_url',
    message: `origin of ${ctx.work}: not a git repository URL`,
  });
});

test('it refuses a checkout that uses submodules', async () => {
  await using ctx = await setupTest();

  await $`git ${['-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', ctx.upstream, 'vendored']}`
    .env(ctx.env)
    .cwd(ctx.work)
    .quiet();

  await $`git commit --quiet -m submodule`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git push --quiet origin main`.env(ctx.env).cwd(ctx.work).quiet();

  const resolved = await resolvePathSource(ctx.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'has_submodules',
    message: `${ctx.work} uses submodules`,
  });
});

test('it resolves the checkout it is given when a git hook exports another GIT_DIR', async () => {
  await using ctx = await setupTest();

  await $`git init --quiet --template= ${join(ctx.dir, 'other')}`.env(ctx.env).quiet();

  updateEnv('GIT_DIR', join(ctx.dir, 'other', '.git'));

  const resolved = await resolvePathSource(ctx.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: true,
    url: ctx.upstream,
    sha: ctx.sha,
    branch: 'main',
    dirty: false,
    warnings: [],
  });
});

test('it refuses a checkout whose HEAD tree cannot be listed', async () => {
  await using ctx = await setupTest();

  const tree = await $`git rev-parse HEAD^{tree}`.env(ctx.env).cwd(ctx.work).text();

  const object = tree.trim();

  await rm(join(ctx.work, '.git', 'objects', object.slice(0, 2), object.slice(2)));

  const resolved = await resolvePathSource(ctx.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'unreadable_tree',
    message: expect.toStartWith(`cannot list the tree of ${ctx.sha} in ${ctx.work}: `),
  });
});

test('it refuses a checkout whose status cannot be read', async () => {
  await using ctx = await setupTest();

  await writeFile(join(ctx.work, '.git', 'index'), 'not an index');

  const resolved = await resolvePathSource(ctx.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'unreadable_tree',
    message: expect.toStartWith(`cannot read the status of ${ctx.work}: `),
  });
});
