import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createGitFixture } from '@atc/test-utils';
import { $ } from 'bun';
import { readRemoteRefs } from './read-remote-refs';

// A bare upstream holding one commit and a work clone that pushes to it.
async function setupTest() {
  const fixture = await createGitFixture({ prefix: 'atc-remote-refs-' });

  return {
    directory: fixture.directory,
    env: fixture.env,
    upstream: fixture.upstream,
    work: fixture.work,
  };
}

test('it lists the branches, the peeled tags, and the default branch of an upstream', async () => {
  const ctx = await setupTest();

  const pushed = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  await $`git tag --no-sign -a v1 -m release`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git tag light`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git branch feat/x`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git push --quiet origin feat/x v1 light`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git push --quiet origin main:refs/pull/1/head`.env(ctx.env).cwd(ctx.work).quiet();

  const tagObject = await $`git rev-parse v1`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  const listing = await readRemoteRefs(ctx.upstream, undefined, ['https', 'ssh', 'file']);

  expect(listing).toStrictEqual({
    ok: true,
    head: 'main',
    refs: [
      { name: 'feat/x', kind: 'branch', sha: pushed },
      { name: 'main', kind: 'branch', sha: pushed },
      { name: 'light', kind: 'tag', sha: pushed },
      { name: 'v1', kind: 'tag', sha: pushed },
    ],
    byName: new Map([
      ['refs/heads/feat/x', pushed],
      ['refs/heads/main', pushed],
      ['refs/tags/light', pushed],
      ['refs/tags/v1', tagObject],
      ['refs/tags/v1^{}', pushed],
    ]),
  });
});

test('it lists an empty upstream as no refs and no default branch', async () => {
  const ctx = await setupTest();

  await $`git init --quiet --bare --template= ${join(ctx.directory, 'empty.git')}`
    .env(ctx.env)
    .quiet();

  const listing = await readRemoteRefs(join(ctx.directory, 'empty.git'), undefined, [
    'https',
    'ssh',
    'file',
  ]);

  expect(listing).toStrictEqual({ ok: true, head: null, refs: [], byName: new Map() });
});

test("it refuses an upstream git cannot read with git's own message", async () => {
  const ctx = await setupTest();

  const listing = await readRemoteRefs(join(ctx.directory, 'missing.git'), undefined, [
    'https',
    'ssh',
    'file',
  ]);

  expect(listing).toStrictEqual({
    ok: false,
    code: 'clone_failed',
    message: expect.toInclude(join(ctx.directory, 'missing.git')),
  });
});

test('it refuses an env credential whose variable is unset', async () => {
  const ctx = await setupTest();

  const listing = await readRemoteRefs(
    ctx.upstream,
    { kind: 'env', name: 'ATC_TEST_UNSET_GIT_TOKEN' },
    ['https', 'ssh', 'file'],
  );

  expect(listing).toStrictEqual({
    ok: false,
    code: 'credential_missing',
    message: 'the credential environment variable is unset or empty',
  });
});
