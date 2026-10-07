import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { $ } from 'bun';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { collectRemoteRefs } from './collect-remote-refs';

test('it lists the branches, the peeled tags, and the default branch of an upstream', async () => {
  await using fixture = await createGitFixture();

  await $`git tag --no-sign -a v1 -m release`.env(fixture.env).cwd(fixture.work).quiet();
  await $`git tag light`.env(fixture.env).cwd(fixture.work).quiet();
  await $`git branch feat/x`.env(fixture.env).cwd(fixture.work).quiet();
  await $`git push --quiet origin feat/x v1 light`.env(fixture.env).cwd(fixture.work).quiet();
  await $`git push --quiet origin main:refs/pull/1/head`.env(fixture.env).cwd(fixture.work).quiet();

  const tagObject = await $`git rev-parse v1`
    .env(fixture.env)
    .cwd(fixture.work)
    .text()
    .then((text) => text.trim());

  const listing = await collectRemoteRefs(fixture.upstream, undefined, ['https', 'ssh', 'file']);

  expect(listing).toStrictEqual({
    ok: true,
    head: 'main',
    refs: [
      { name: 'feat/x', kind: 'branch', sha: fixture.sha },
      { name: 'main', kind: 'branch', sha: fixture.sha },
      { name: 'light', kind: 'tag', sha: fixture.sha },
      { name: 'v1', kind: 'tag', sha: fixture.sha },
    ],
    byName: new Map([
      ['refs/heads/feat/x', fixture.sha],
      ['refs/heads/main', fixture.sha],
      ['refs/tags/light', fixture.sha],
      ['refs/tags/v1', tagObject],
      ['refs/tags/v1^{}', fixture.sha],
    ]),
  });
});

test('it lists an empty upstream as no refs and no default branch', async () => {
  await using fixture = await createGitFixture();

  await $`git init --quiet --bare --template= ${join(fixture.dir, 'empty.git')}`
    .env(fixture.env)
    .quiet();

  const listing = await collectRemoteRefs(join(fixture.dir, 'empty.git'), undefined, [
    'https',
    'ssh',
    'file',
  ]);

  expect(listing).toStrictEqual({ ok: true, head: null, refs: [], byName: new Map() });
});

test("it refuses an upstream git cannot read with git's own message", async () => {
  await using fixture = await createGitFixture();

  const listing = await collectRemoteRefs(join(fixture.dir, 'missing.git'), undefined, [
    'https',
    'ssh',
    'file',
  ]);

  expect(listing).toStrictEqual({
    ok: false,
    code: 'clone_failed',
    message: expect.toInclude(join(fixture.dir, 'missing.git')),
  });
});

test('it refuses an env credential whose variable is unset', async () => {
  await using fixture = await createGitFixture();

  const listing = await collectRemoteRefs(
    fixture.upstream,
    { kind: 'env', name: 'ATC_TEST_UNSET_GIT_TOKEN' },
    ['https', 'ssh', 'file'],
  );

  expect(listing).toStrictEqual({
    ok: false,
    code: 'credential_missing',
    message: 'the credential environment variable is unset or empty',
  });
});
