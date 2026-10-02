import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { resolvePathSource } from './resolve-path-source';

async function setupTest() {
  // A git hook exports GIT_DIR and friends, which would point these
  // commands at the repository running the hook instead of the temp tree.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );

  const dir = await mkdtemp(join(tmpdir(), 'atc-path-source-'));

  const upstream = join(dir, 'upstream.git');
  const work = join(dir, 'work');

  await $`git init --quiet --bare --template= --initial-branch=main ${upstream}`.env(env).quiet();
  await $`git clone --quiet --template= ${upstream} ${work}`.env(env).quiet();
  await $`git config user.name atc`.env(env).cwd(work).quiet();
  await $`git config user.email atc@example.com`.env(env).cwd(work).quiet();
  await $`git config commit.gpgsign false`.env(env).cwd(work).quiet();

  await writeFile(join(work, 'README.md'), 'hello\n');

  await $`git add README.md`.env(env).cwd(work).quiet();
  await $`git commit --quiet -m initial`.env(env).cwd(work).quiet();
  await $`git push --quiet origin main`.env(env).cwd(work).quiet();

  return {
    env,
    dir,
    upstream,
    work,
    async [Symbol.asyncDispose]() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('it resolves a clean pushed checkout to its origin URL and HEAD', async () => {
  await using project = await setupTest();

  const head = await $`git rev-parse HEAD`.env(project.env).cwd(project.work).text();
  const resolved = await resolvePathSource(project.work);

  expect(resolved).toStrictEqual({
    ok: true,
    url: project.upstream,
    sha: head.trim(),
    branch: 'main',
    dirty: false,
    warnings: [],
  });
});

test('it resolves a subdirectory to the checkout that holds it', async () => {
  await using project = await setupTest();

  await mkdir(join(project.work, 'nested'));

  const resolved = await resolvePathSource(join(project.work, 'nested'));

  expect(resolved).toMatchObject({ ok: true, url: project.upstream });
});

test('it strips a token from the origin URL', async () => {
  await using project = await setupTest();

  await $`git remote set-url origin https://x-access-token:ghp_secret@github.com/zgeoff/atc.git`
    .env(project.env)
    .cwd(project.work)
    .quiet();

  await $`git update-ref refs/remotes/origin/main HEAD`.env(project.env).cwd(project.work).quiet();

  const resolved = await resolvePathSource(project.work);

  expect(resolved).toMatchObject({ ok: true, url: 'https://github.com/zgeoff/atc.git' });
});

test('it refuses a checkout with an uncommitted change', async () => {
  await using project = await setupTest();

  await writeFile(join(project.work, 'README.md'), 'edited\n');

  const resolved = await resolvePathSource(project.work);

  expect(resolved).toMatchObject({ ok: false, code: 'workspace_dirty' });
});

test('it refuses a checkout with an untracked file as dirty', async () => {
  await using project = await setupTest();

  await writeFile(join(project.work, 'notes.txt'), 'scratch\n');

  const resolved = await resolvePathSource(project.work);

  expect(resolved).toMatchObject({ ok: false, code: 'workspace_dirty' });
});

test('it resolves a dirty checkout to HEAD with a warning when dirt is allowed', async () => {
  await using project = await setupTest();

  const head = await $`git rev-parse HEAD`.env(project.env).cwd(project.work).text();

  await writeFile(join(project.work, 'README.md'), 'edited\n');

  const resolved = await resolvePathSource(project.work, { allowDirty: 'warn' });

  expect(resolved).toStrictEqual({
    ok: true,
    url: project.upstream,
    sha: head.trim(),
    branch: 'main',
    dirty: true,
    warnings: [expect.stringContaining(head.trim())],
  });
});

test('it refuses a directory outside any git repository', async () => {
  await using project = await setupTest();

  await mkdir(join(project.dir, 'loose'));

  const resolved = await resolvePathSource(join(project.dir, 'loose'));

  expect(resolved).toMatchObject({ ok: false, code: 'not_a_git_repo' });
});

test('it refuses a path that does not exist', async () => {
  await using project = await setupTest();

  const resolved = await resolvePathSource(join(project.dir, 'missing'));

  expect(resolved).toMatchObject({ ok: false, code: 'not_a_git_repo' });
});

test('it refuses a repository with no commits', async () => {
  await using project = await setupTest();

  await $`git init --quiet --template= ${join(project.dir, 'empty')}`.env(project.env).quiet();

  const resolved = await resolvePathSource(join(project.dir, 'empty'));

  expect(resolved).toMatchObject({ ok: false, code: 'no_commits' });
});

test('it refuses a HEAD commit that was never pushed', async () => {
  await using project = await setupTest();

  await writeFile(join(project.work, 'README.md'), 'local only\n');

  await $`git commit --quiet -am local`.env(project.env).cwd(project.work).quiet();

  const resolved = await resolvePathSource(project.work);

  expect(resolved).toMatchObject({ ok: false, code: 'unpushed_head' });
});

test('it refuses a HEAD commit that only another remote holds', async () => {
  await using project = await setupTest();

  await writeFile(join(project.work, 'README.md'), 'fork only\n');

  await $`git commit --quiet -am fork`.env(project.env).cwd(project.work).quiet();
  await $`git update-ref refs/remotes/fork/main HEAD`.env(project.env).cwd(project.work).quiet();

  const resolved = await resolvePathSource(project.work);

  expect(resolved).toMatchObject({ ok: false, code: 'unpushed_head' });
});

test('it accepts a pushed HEAD whose remote-tracking ref was never fetched', async () => {
  await using project = await setupTest();

  await writeFile(join(project.work, 'README.md'), 'pushed elsewhere\n');

  await $`git commit --quiet -am pushed`.env(project.env).cwd(project.work).quiet();

  await $`git push --quiet ${project.upstream} HEAD:refs/heads/other`
    .env(project.env)
    .cwd(project.work)
    .quiet();

  const resolved = await resolvePathSource(project.work);

  expect(resolved).toMatchObject({ ok: true, url: project.upstream });
});

test('it refuses a checkout with no origin remote', async () => {
  await using project = await setupTest();

  await $`git remote remove origin`.env(project.env).cwd(project.work).quiet();

  const resolved = await resolvePathSource(project.work);

  expect(resolved).toMatchObject({ ok: false, code: 'no_origin' });
});

test('it refuses an origin URL it cannot read as a repository URL', async () => {
  await using project = await setupTest();

  await $`git remote set-url origin 'not a url'`.env(project.env).cwd(project.work).quiet();

  const resolved = await resolvePathSource(project.work);

  expect(resolved).toMatchObject({ ok: false, code: 'invalid_git_url' });
});

test('it refuses a checkout that uses submodules', async () => {
  await using project = await setupTest();

  await $`git ${['-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', project.upstream, 'vendored']}`
    .env(project.env)
    .cwd(project.work)
    .quiet();

  await $`git commit --quiet -m submodule`.env(project.env).cwd(project.work).quiet();
  await $`git push --quiet origin main`.env(project.env).cwd(project.work).quiet();

  const resolved = await resolvePathSource(project.work);

  expect(resolved).toMatchObject({ ok: false, code: 'has_submodules' });
});

test('it resolves the checkout it is given when a git hook exports another GIT_DIR', async () => {
  await using project = await setupTest();

  await $`git init --quiet --template= ${join(project.dir, 'other')}`.env(project.env).quiet();

  process.env['GIT_DIR'] = join(project.dir, 'other', '.git');

  onTestFinished(() => {
    delete process.env['GIT_DIR'];
  });

  const resolved = await resolvePathSource(project.work);

  expect(resolved).toMatchObject({ ok: true, url: project.upstream, branch: 'main' });
});

test('it refuses a checkout whose HEAD tree cannot be listed', async () => {
  await using project = await setupTest();

  const tree = await $`git rev-parse HEAD^{tree}`.env(project.env).cwd(project.work).text();

  const object = tree.trim();

  await rm(join(project.work, '.git', 'objects', object.slice(0, 2), object.slice(2)));

  const resolved = await resolvePathSource(project.work);

  expect(resolved).toMatchObject({ ok: false, code: 'unreadable_tree' });
});

test('it refuses a checkout whose status cannot be read', async () => {
  await using project = await setupTest();

  await writeFile(join(project.work, '.git', 'index'), 'not an index');

  const resolved = await resolvePathSource(project.work);

  expect(resolved).toMatchObject({ ok: false, code: 'unreadable_tree' });
});
