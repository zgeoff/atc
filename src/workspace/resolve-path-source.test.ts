import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { updateEnv } from '../../test/update-env';
import { resolvePathSource } from './resolve-path-source';

// The transports a fixture upstream on the local filesystem is reached over.
const FIXTURE_TRANSPORTS = ['https', 'ssh', 'file'];

async function setupTest() {
  // A git hook exports GIT_DIR and friends, which would point these
  // commands at the repository running the hook instead of the temp tree.
  // The host's system and global config are ignored too: a system-wide Git
  // LFS install adds hooks to every repository its filter touches, and its
  // pre-push hook refuses the fixture's pointer files.
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };

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
  const resolved = await resolvePathSource(project.work, { transports: FIXTURE_TRANSPORTS });

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

  const resolved = await resolvePathSource(join(project.work, 'nested'), {
    transports: FIXTURE_TRANSPORTS,
  });

  expect(resolved).toMatchObject({ ok: true, url: project.upstream });
});

test('it strips a token from the origin URL', async () => {
  await using project = await setupTest();

  await $`git remote set-url origin https://x-access-token:ghp_secret@github.com/zgeoff/atc.git`
    .env(project.env)
    .cwd(project.work)
    .quiet();

  await $`git update-ref refs/remotes/origin/main HEAD`.env(project.env).cwd(project.work).quiet();

  const resolved = await resolvePathSource(project.work, { transports: FIXTURE_TRANSPORTS });

  expect(resolved).toMatchObject({ ok: true, url: 'https://github.com/zgeoff/atc.git' });
});

test('it resolves a checkout with an uncommitted change to HEAD with a warning that counts it', async () => {
  await using project = await setupTest();

  const head = await $`git rev-parse HEAD`.env(project.env).cwd(project.work).text();

  await writeFile(join(project.work, 'README.md'), 'edited\n');

  const resolved = await resolvePathSource(project.work, { transports: FIXTURE_TRANSPORTS });

  expect(resolved).toStrictEqual({
    ok: true,
    url: project.upstream,
    sha: head.trim(),
    branch: 'main',
    dirty: true,
    warnings: [
      `cloned commit ${head.slice(0, 12)}; left 1 uncommitted or untracked path behind in ${project.work}`,
    ],
  });
});

test('it resolves a checkout with untracked files to HEAD without naming them', async () => {
  await using project = await setupTest();

  const head = await $`git rev-parse HEAD`.env(project.env).cwd(project.work).text();

  await writeFile(join(project.work, '.env'), 'TOKEN=secret\n');
  await writeFile(join(project.work, 'notes.txt'), 'scratch\n');

  const resolved = await resolvePathSource(project.work, { transports: FIXTURE_TRANSPORTS });

  expect(resolved).toStrictEqual({
    ok: true,
    url: project.upstream,
    sha: head.trim(),
    branch: 'main',
    dirty: true,
    warnings: [
      `cloned commit ${head.slice(0, 12)}; left 2 uncommitted or untracked paths behind in ${project.work}`,
    ],
  });
});

test('it counts each file inside an untracked directory', async () => {
  await using project = await setupTest();

  const head = await $`git rev-parse HEAD`.env(project.env).cwd(project.work).text();

  await mkdir(join(project.work, 'drafts'));
  await writeFile(join(project.work, 'drafts', 'a.txt'), 'a\n');
  await writeFile(join(project.work, 'drafts', 'b.txt'), 'b\n');
  await writeFile(join(project.work, 'drafts', 'c.txt'), 'c\n');

  const resolved = await resolvePathSource(project.work, { transports: FIXTURE_TRANSPORTS });

  expect(resolved).toMatchObject({
    ok: true,
    warnings: [
      `cloned commit ${head.slice(0, 12)}; left 3 uncommitted or untracked paths behind in ${project.work}`,
    ],
  });
});

test('it leaves the changes of a dirty checkout as they were', async () => {
  await using project = await setupTest();

  await writeFile(join(project.work, 'README.md'), 'edited\n');
  await writeFile(join(project.work, 'notes.txt'), 'scratch\n');

  await $`git add notes.txt`.env(project.env).cwd(project.work).quiet();

  const before = await $`git status --porcelain`.env(project.env).cwd(project.work).text();

  await resolvePathSource(project.work, { transports: FIXTURE_TRANSPORTS });

  const after = await $`git status --porcelain`.env(project.env).cwd(project.work).text();
  const readme = await readFile(join(project.work, 'README.md'), 'utf8');
  const notes = await readFile(join(project.work, 'notes.txt'), 'utf8');

  expect(after).toBe(before);
  expect(readme).toBe('edited\n');
  expect(notes).toBe('scratch\n');
});

test('it refuses a checkout with an uncommitted change when dirt is refused', async () => {
  await using project = await setupTest();

  await writeFile(join(project.work, 'README.md'), 'edited\n');

  const resolved = await resolvePathSource(project.work, {
    allowDirty: 'refuse',
    transports: FIXTURE_TRANSPORTS,
  });

  expect(resolved).toMatchObject({ ok: false, code: 'workspace_dirty' });
});

test('it refuses a checkout with an untracked file when dirt is refused', async () => {
  await using project = await setupTest();

  await writeFile(join(project.work, 'notes.txt'), 'scratch\n');

  const resolved = await resolvePathSource(project.work, {
    allowDirty: 'refuse',
    transports: FIXTURE_TRANSPORTS,
  });

  expect(resolved).toMatchObject({ ok: false, code: 'workspace_dirty' });
});

test('it refuses a dirty checkout whose HEAD origin does not hold rather than resolve an older commit', async () => {
  await using project = await setupTest();

  await writeFile(join(project.work, 'README.md'), 'local\n');

  await $`git commit --quiet -am local`.env(project.env).cwd(project.work).quiet();

  await writeFile(join(project.work, 'notes.txt'), 'scratch\n');

  const resolved = await resolvePathSource(project.work, { transports: FIXTURE_TRANSPORTS });

  expect(resolved).toMatchObject({ ok: false, code: 'unpushed_head' });
});

test('it resolves a dirty checkout to HEAD with a warning when dirt is allowed', async () => {
  await using project = await setupTest();

  const head = await $`git rev-parse HEAD`.env(project.env).cwd(project.work).text();

  await writeFile(join(project.work, 'README.md'), 'edited\n');

  const resolved = await resolvePathSource(project.work, {
    allowDirty: 'warn',
    transports: FIXTURE_TRANSPORTS,
  });

  expect(resolved).toStrictEqual({
    ok: true,
    url: project.upstream,
    sha: head.trim(),
    branch: 'main',
    dirty: true,
    warnings: [expect.stringContaining(head.slice(0, 12))],
  });
});

test('it refuses a directory outside any git repository', async () => {
  await using project = await setupTest();

  await mkdir(join(project.dir, 'loose'));

  const resolved = await resolvePathSource(join(project.dir, 'loose'), {
    transports: FIXTURE_TRANSPORTS,
  });

  expect(resolved).toMatchObject({ ok: false, code: 'not_a_git_repo' });
});

test('it refuses a path that does not exist', async () => {
  await using project = await setupTest();

  const resolved = await resolvePathSource(join(project.dir, 'missing'), {
    transports: FIXTURE_TRANSPORTS,
  });

  expect(resolved).toMatchObject({ ok: false, code: 'not_a_git_repo' });
});

test('it refuses a repository with no commits', async () => {
  await using project = await setupTest();

  await $`git init --quiet --template= ${join(project.dir, 'empty')}`.env(project.env).quiet();

  const resolved = await resolvePathSource(join(project.dir, 'empty'), {
    transports: FIXTURE_TRANSPORTS,
  });

  expect(resolved).toMatchObject({ ok: false, code: 'no_commits' });
});

test('it refuses a HEAD commit that was never pushed', async () => {
  await using project = await setupTest();

  await writeFile(join(project.work, 'README.md'), 'local only\n');

  await $`git commit --quiet -am local`.env(project.env).cwd(project.work).quiet();

  const resolved = await resolvePathSource(project.work, { transports: FIXTURE_TRANSPORTS });

  expect(resolved).toMatchObject({ ok: false, code: 'unpushed_head' });
});

test('it refuses a HEAD commit that only another remote holds', async () => {
  await using project = await setupTest();

  await writeFile(join(project.work, 'README.md'), 'fork only\n');

  await $`git commit --quiet -am fork`.env(project.env).cwd(project.work).quiet();
  await $`git update-ref refs/remotes/fork/main HEAD`.env(project.env).cwd(project.work).quiet();

  const resolved = await resolvePathSource(project.work, { transports: FIXTURE_TRANSPORTS });

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

  const resolved = await resolvePathSource(project.work, { transports: FIXTURE_TRANSPORTS });

  expect(resolved).toMatchObject({ ok: true, url: project.upstream });
});

test('it refuses a checkout with no origin remote', async () => {
  await using project = await setupTest();

  await $`git remote remove origin`.env(project.env).cwd(project.work).quiet();

  const resolved = await resolvePathSource(project.work, { transports: FIXTURE_TRANSPORTS });

  expect(resolved).toMatchObject({ ok: false, code: 'no_origin' });
});

test('it refuses an origin URL it cannot read as a repository URL', async () => {
  await using project = await setupTest();

  await $`git remote set-url origin 'not a url'`.env(project.env).cwd(project.work).quiet();

  const resolved = await resolvePathSource(project.work, { transports: FIXTURE_TRANSPORTS });

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

  const resolved = await resolvePathSource(project.work, { transports: FIXTURE_TRANSPORTS });

  expect(resolved).toMatchObject({ ok: false, code: 'has_submodules' });
});

test('it resolves the checkout it is given when a git hook exports another GIT_DIR', async () => {
  await using project = await setupTest();

  await $`git init --quiet --template= ${join(project.dir, 'other')}`.env(project.env).quiet();

  updateEnv('GIT_DIR', join(project.dir, 'other', '.git'));

  const resolved = await resolvePathSource(project.work, { transports: FIXTURE_TRANSPORTS });

  expect(resolved).toMatchObject({ ok: true, url: project.upstream, branch: 'main' });
});

test('it refuses a checkout whose HEAD tree cannot be listed', async () => {
  await using project = await setupTest();

  const tree = await $`git rev-parse HEAD^{tree}`.env(project.env).cwd(project.work).text();

  const object = tree.trim();

  await rm(join(project.work, '.git', 'objects', object.slice(0, 2), object.slice(2)));

  const resolved = await resolvePathSource(project.work, { transports: FIXTURE_TRANSPORTS });

  expect(resolved).toMatchObject({ ok: false, code: 'unreadable_tree' });
});

test('it refuses a checkout whose status cannot be read', async () => {
  await using project = await setupTest();

  await writeFile(join(project.work, '.git', 'index'), 'not an index');

  const resolved = await resolvePathSource(project.work, { transports: FIXTURE_TRANSPORTS });

  expect(resolved).toMatchObject({ ok: false, code: 'unreadable_tree' });
});
