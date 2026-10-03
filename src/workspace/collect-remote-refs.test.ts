import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { collectRemoteRefs } from './collect-remote-refs';

// A bare upstream and a work clone that pushes to it. Fixture git commands
// read neither the host's system nor its global git config.
async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'atc-remote-refs-'));

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'atc',
    GIT_AUTHOR_EMAIL: 'atc@example.com',
    GIT_COMMITTER_NAME: 'atc',
    GIT_COMMITTER_EMAIL: 'atc@example.com',
  };

  const upstream = join(dir, 'upstream.git');
  const work = join(dir, 'work');

  await $`git init --quiet --bare --template= --initial-branch=trunk ${upstream}`.env(env).quiet();
  await $`git clone --quiet --template= ${upstream} ${work}`.env(env).quiet();

  return {
    dir,
    env,
    upstream,
    work,
    async [Symbol.asyncDispose]() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('it lists the branches, the peeled tags, and the default branch of an upstream', async () => {
  await using project = await setupTest();

  await writeFile(join(project.work, 'README.md'), 'hello\n');

  await $`git add README.md`.env(project.env).cwd(project.work).quiet();
  await $`git commit --quiet --no-gpg-sign -m initial`.env(project.env).cwd(project.work).quiet();
  await $`git tag --no-sign -a v1 -m release`.env(project.env).cwd(project.work).quiet();
  await $`git tag light`.env(project.env).cwd(project.work).quiet();
  await $`git branch feat/x`.env(project.env).cwd(project.work).quiet();
  await $`git push --quiet origin trunk feat/x v1 light`.env(project.env).cwd(project.work).quiet();

  await $`git push --quiet origin trunk:refs/pull/1/head`
    .env(project.env)
    .cwd(project.work)
    .quiet();

  const sha = await $`git rev-parse HEAD`
    .env(project.env)
    .cwd(project.work)
    .text()
    .then((text) => text.trim());

  const tagObject = await $`git rev-parse v1`
    .env(project.env)
    .cwd(project.work)
    .text()
    .then((text) => text.trim());

  const listing = await collectRemoteRefs(project.upstream, undefined);

  expect(listing).toStrictEqual({
    ok: true,
    head: 'trunk',
    refs: [
      { name: 'feat/x', kind: 'branch', sha },
      { name: 'trunk', kind: 'branch', sha },
      { name: 'light', kind: 'tag', sha },
      { name: 'v1', kind: 'tag', sha },
    ],
    byName: new Map([
      ['refs/heads/feat/x', sha],
      ['refs/heads/trunk', sha],
      ['refs/tags/light', sha],
      ['refs/tags/v1', tagObject],
      ['refs/tags/v1^{}', sha],
    ]),
  });
});

test('it lists an empty upstream as no refs and no default branch', async () => {
  await using project = await setupTest();

  const listing = await collectRemoteRefs(project.upstream, undefined);

  expect(listing).toStrictEqual({ ok: true, head: null, refs: [], byName: new Map() });
});

test("it refuses an upstream git cannot read with git's own message", async () => {
  await using project = await setupTest();

  const listing = await collectRemoteRefs(join(project.dir, 'missing.git'), undefined);

  expect(listing).toMatchObject({
    ok: false,
    code: 'clone_failed',
    message: expect.toInclude('missing.git'),
  });
});

test('it refuses an env credential whose variable is unset', async () => {
  await using project = await setupTest();

  const listing = await collectRemoteRefs(project.upstream, {
    kind: 'env',
    name: 'ATC_TEST_UNSET_GIT_TOKEN',
  });

  expect(listing).toStrictEqual({
    ok: false,
    code: 'credential_missing',
    message: 'the credential environment variable is unset or empty',
  });
});
