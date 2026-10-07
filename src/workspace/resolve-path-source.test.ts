import { expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { updateEnv } from '../test-utils/update-env';
import { resolvePathSource } from './resolve-path-source';

test('it resolves a clean pushed checkout to its origin URL and HEAD', async () => {
  await using fixture = await createGitFixture();

  const resolved = await resolvePathSource(fixture.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: true,
    url: fixture.upstream,
    sha: fixture.sha,
    branch: 'main',
    dirty: false,
    warnings: [],
  });
});

test('it resolves a subdirectory to the checkout that holds it', async () => {
  await using fixture = await createGitFixture();

  await mkdir(join(fixture.work, 'nested'));

  const resolved = await resolvePathSource(join(fixture.work, 'nested'), {
    transports: ['https', 'ssh', 'file'],
  });

  expect(resolved).toStrictEqual({
    ok: true,
    url: fixture.upstream,
    sha: fixture.sha,
    branch: 'main',
    dirty: false,
    warnings: [],
  });
});

test('it strips a token from the origin URL', async () => {
  await using fixture = await createGitFixture();

  await $`git remote set-url origin https://x-access-token:ghp_secret@github.com/zgeoff/atc.git`
    .env(fixture.env)
    .cwd(fixture.work)
    .quiet();

  await $`git update-ref refs/remotes/origin/main HEAD`.env(fixture.env).cwd(fixture.work).quiet();

  const resolved = await resolvePathSource(fixture.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: true,
    url: 'https://github.com/zgeoff/atc.git',
    sha: fixture.sha,
    branch: 'main',
    dirty: false,
    warnings: [],
  });
});

test('it resolves a checkout with an uncommitted change to HEAD with a warning that counts it', async () => {
  await using fixture = await createGitFixture();

  await writeFile(join(fixture.work, 'README.md'), 'edited\n');

  const resolved = await resolvePathSource(fixture.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: true,
    url: fixture.upstream,
    sha: fixture.sha,
    branch: 'main',
    dirty: true,
    warnings: [
      `cloned commit ${fixture.sha.slice(0, 12)}; left 1 uncommitted or untracked path behind in ${fixture.work}`,
    ],
  });
});

test('it resolves a checkout with untracked files to HEAD without naming them', async () => {
  await using fixture = await createGitFixture();

  await writeFile(join(fixture.work, '.env'), 'TOKEN=secret\n');
  await writeFile(join(fixture.work, 'notes.txt'), 'scratch\n');

  const resolved = await resolvePathSource(fixture.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: true,
    url: fixture.upstream,
    sha: fixture.sha,
    branch: 'main',
    dirty: true,
    warnings: [
      `cloned commit ${fixture.sha.slice(0, 12)}; left 2 uncommitted or untracked paths behind in ${fixture.work}`,
    ],
  });
});

test('it counts each file inside an untracked directory', async () => {
  await using fixture = await createGitFixture();

  await mkdir(join(fixture.work, 'drafts'));
  await writeFile(join(fixture.work, 'drafts', 'a.txt'), 'a\n');
  await writeFile(join(fixture.work, 'drafts', 'b.txt'), 'b\n');
  await writeFile(join(fixture.work, 'drafts', 'c.txt'), 'c\n');

  const resolved = await resolvePathSource(fixture.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: true,
    url: fixture.upstream,
    sha: fixture.sha,
    branch: 'main',
    dirty: true,
    warnings: [
      `cloned commit ${fixture.sha.slice(0, 12)}; left 3 uncommitted or untracked paths behind in ${fixture.work}`,
    ],
  });
});

test('it leaves the changes of a dirty checkout as they were', async () => {
  await using fixture = await createGitFixture();

  await writeFile(join(fixture.work, 'README.md'), 'edited\n');
  await writeFile(join(fixture.work, 'notes.txt'), 'scratch\n');

  await $`git add notes.txt`.env(fixture.env).cwd(fixture.work).quiet();

  const before = await $`git status --porcelain`.env(fixture.env).cwd(fixture.work).text();

  await resolvePathSource(fixture.work, { transports: ['https', 'ssh', 'file'] });

  const after = await $`git status --porcelain`.env(fixture.env).cwd(fixture.work).text();
  const readme = await readFile(join(fixture.work, 'README.md'), 'utf8');
  const notes = await readFile(join(fixture.work, 'notes.txt'), 'utf8');

  expect(after).toBe(before);
  expect(readme).toBe('edited\n');
  expect(notes).toBe('scratch\n');
});

test('it refuses a checkout with an uncommitted change when dirt is refused', async () => {
  await using fixture = await createGitFixture();

  await writeFile(join(fixture.work, 'README.md'), 'edited\n');

  const resolved = await resolvePathSource(fixture.work, {
    allowDirty: 'refuse',
    transports: ['https', 'ssh', 'file'],
  });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'workspace_dirty',
    message: `${fixture.work} has uncommitted or untracked changes`,
  });
});

test('it refuses a checkout with an untracked file when dirt is refused', async () => {
  await using fixture = await createGitFixture();

  await writeFile(join(fixture.work, 'notes.txt'), 'scratch\n');

  const resolved = await resolvePathSource(fixture.work, {
    allowDirty: 'refuse',
    transports: ['https', 'ssh', 'file'],
  });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'workspace_dirty',
    message: `${fixture.work} has uncommitted or untracked changes`,
  });
});

test('it refuses a dirty checkout whose HEAD origin does not hold rather than resolve an older commit', async () => {
  await using fixture = await createGitFixture();

  await writeFile(join(fixture.work, 'README.md'), 'local\n');

  await $`git commit --quiet -am local`.env(fixture.env).cwd(fixture.work).quiet();

  await writeFile(join(fixture.work, 'notes.txt'), 'scratch\n');

  const sha = await $`git rev-parse HEAD`
    .env(fixture.env)
    .cwd(fixture.work)
    .text()
    .then((text) => text.trim());

  const resolved = await resolvePathSource(fixture.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'unpushed_head',
    message: `${sha} is not on origin; push it first`,
  });
});

test('it resolves a dirty checkout to HEAD with a warning when dirt is allowed', async () => {
  await using fixture = await createGitFixture();

  await writeFile(join(fixture.work, 'README.md'), 'edited\n');

  const resolved = await resolvePathSource(fixture.work, {
    allowDirty: 'warn',
    transports: ['https', 'ssh', 'file'],
  });

  expect(resolved).toStrictEqual({
    ok: true,
    url: fixture.upstream,
    sha: fixture.sha,
    branch: 'main',
    dirty: true,
    warnings: [
      `cloned commit ${fixture.sha.slice(0, 12)}; left 1 uncommitted or untracked path behind in ${fixture.work}`,
    ],
  });
});

test('it refuses a directory outside any git repository', async () => {
  await using fixture = await createGitFixture();

  await mkdir(join(fixture.dir, 'loose'));

  const resolved = await resolvePathSource(join(fixture.dir, 'loose'), {
    transports: ['https', 'ssh', 'file'],
  });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'not_a_git_repo',
    message: `${join(fixture.dir, 'loose')} is not inside a git work tree`,
  });
});

test('it refuses a path that does not exist', async () => {
  await using fixture = await createGitFixture();

  const resolved = await resolvePathSource(join(fixture.dir, 'missing'), {
    transports: ['https', 'ssh', 'file'],
  });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'not_a_git_repo',
    message: `${join(fixture.dir, 'missing')} is not a directory`,
  });
});

test('it refuses a repository with no commits', async () => {
  await using fixture = await createGitFixture();

  await $`git init --quiet --template= ${join(fixture.dir, 'empty')}`.env(fixture.env).quiet();

  const resolved = await resolvePathSource(join(fixture.dir, 'empty'), {
    transports: ['https', 'ssh', 'file'],
  });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'no_commits',
    message: `${join(fixture.dir, 'empty')} has no commit to check out`,
  });
});

test('it refuses a HEAD commit that was never pushed', async () => {
  await using fixture = await createGitFixture();

  await writeFile(join(fixture.work, 'README.md'), 'local only\n');

  await $`git commit --quiet -am local`.env(fixture.env).cwd(fixture.work).quiet();

  const sha = await $`git rev-parse HEAD`
    .env(fixture.env)
    .cwd(fixture.work)
    .text()
    .then((text) => text.trim());

  const resolved = await resolvePathSource(fixture.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'unpushed_head',
    message: `${sha} is not on origin; push it first`,
  });
});

test('it refuses a HEAD commit that only another remote holds', async () => {
  await using fixture = await createGitFixture();

  await writeFile(join(fixture.work, 'README.md'), 'fork only\n');

  await $`git commit --quiet -am fork`.env(fixture.env).cwd(fixture.work).quiet();
  await $`git update-ref refs/remotes/fork/main HEAD`.env(fixture.env).cwd(fixture.work).quiet();

  const sha = await $`git rev-parse HEAD`
    .env(fixture.env)
    .cwd(fixture.work)
    .text()
    .then((text) => text.trim());

  const resolved = await resolvePathSource(fixture.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'unpushed_head',
    message: `${sha} is not on origin; push it first`,
  });
});

test('it accepts a pushed HEAD whose remote-tracking ref was never fetched', async () => {
  await using fixture = await createGitFixture();

  await writeFile(join(fixture.work, 'README.md'), 'pushed elsewhere\n');

  await $`git commit --quiet -am pushed`.env(fixture.env).cwd(fixture.work).quiet();

  const sha = await $`git rev-parse HEAD`
    .env(fixture.env)
    .cwd(fixture.work)
    .text()
    .then((text) => text.trim());

  await $`git push --quiet ${fixture.upstream} HEAD:refs/heads/other`
    .env(fixture.env)
    .cwd(fixture.work)
    .quiet();

  const resolved = await resolvePathSource(fixture.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: true,
    url: fixture.upstream,
    sha,
    branch: 'main',
    dirty: false,
    warnings: [],
  });
});

test('it refuses a checkout with no origin remote', async () => {
  await using fixture = await createGitFixture();

  await $`git remote remove origin`.env(fixture.env).cwd(fixture.work).quiet();

  const resolved = await resolvePathSource(fixture.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'no_origin',
    message: `${fixture.work} has no origin remote`,
  });
});

test('it refuses an origin URL it cannot read as a repository URL', async () => {
  await using fixture = await createGitFixture();

  await $`git remote set-url origin 'not a url'`.env(fixture.env).cwd(fixture.work).quiet();

  const resolved = await resolvePathSource(fixture.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'invalid_git_url',
    message: `origin of ${fixture.work}: not a git repository URL`,
  });
});

test('it refuses a checkout that uses submodules', async () => {
  await using fixture = await createGitFixture();

  await $`git ${['-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', fixture.upstream, 'vendored']}`
    .env(fixture.env)
    .cwd(fixture.work)
    .quiet();

  await $`git commit --quiet -m submodule`.env(fixture.env).cwd(fixture.work).quiet();
  await $`git push --quiet origin main`.env(fixture.env).cwd(fixture.work).quiet();

  const resolved = await resolvePathSource(fixture.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'has_submodules',
    message: `${fixture.work} uses submodules`,
  });
});

test('it resolves the checkout it is given when a git hook exports another GIT_DIR', async () => {
  await using fixture = await createGitFixture();

  await $`git init --quiet --template= ${join(fixture.dir, 'other')}`.env(fixture.env).quiet();

  updateEnv('GIT_DIR', join(fixture.dir, 'other', '.git'));

  const resolved = await resolvePathSource(fixture.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: true,
    url: fixture.upstream,
    sha: fixture.sha,
    branch: 'main',
    dirty: false,
    warnings: [],
  });
});

test('it refuses a checkout whose HEAD tree cannot be listed', async () => {
  await using fixture = await createGitFixture();

  const tree = await $`git rev-parse HEAD^{tree}`.env(fixture.env).cwd(fixture.work).text();

  const object = tree.trim();

  await rm(join(fixture.work, '.git', 'objects', object.slice(0, 2), object.slice(2)));

  const resolved = await resolvePathSource(fixture.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'unreadable_tree',
    message: expect.toStartWith(`cannot list the tree of ${fixture.sha} in ${fixture.work}: `),
  });
});

test('it refuses a checkout whose status cannot be read', async () => {
  await using fixture = await createGitFixture();

  await writeFile(join(fixture.work, '.git', 'index'), 'not an index');

  const resolved = await resolvePathSource(fixture.work, { transports: ['https', 'ssh', 'file'] });

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'unreadable_tree',
    message: expect.toStartWith(`cannot read the status of ${fixture.work}: `),
  });
});
