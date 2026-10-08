import { expect, test } from 'bun:test';
import { $ } from 'bun';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { checkURLCredentials } from './check-url-credentials';

// A repository whose own config holds the rewrites a test adds.
async function setupTest() {
  const fixture = await createGitFixture({ prefix: 'atc-url-credentials-' });

  return { env: fixture.env, work: fixture.work };
}

test.each([
  ['an https URL', 'https://github.com/owner/repo.git'],
  ['an ssh URL with a login user', 'ssh://git@github.com/owner/repo.git'],
  ['an scp-style URL', 'git@github.com:owner/repo.git'],
  ['a local path', '/srv/git/repo.git'],
])('it accepts %s that carries no credential', async (_, url) => {
  const ctx = await setupTest();
  const finding = await checkURLCredentials(url, ctx.work);

  expect(finding).toStrictEqual({ ok: true });
});

test.each([
  ['userinfo', 'https://x-access-token:tok-1@github.com/owner/repo.git'],
  ['a bare user', 'https://tok-1@github.com/owner/repo.git'],
  ['a query', 'https://github.com/owner/repo.git?private_token=tok-1'],
  ['a fragment', 'https://github.com/owner/repo.git#tok-1'],
  ['an ssh password', 'ssh://git:tok-1@github.com/owner/repo.git'],
])('it refuses a URL whose %s carries a credential', async (_, url) => {
  const ctx = await setupTest();
  const finding = await checkURLCredentials(url, ctx.work);

  expect(finding).toStrictEqual({
    ok: false,
    code: 'credential_in_url',
    message: 'the repository URL carries a credential; pass it as a credentialRef instead',
  });
});

test('it refuses a URL an insteadOf rewrite expands into one with a token', async () => {
  const ctx = await setupTest();

  await $`git config url.https://x-access-token:tok-1@github.com/.insteadOf https://github.com/`
    .env(ctx.env)
    .cwd(ctx.work)
    .quiet();

  const finding = await checkURLCredentials('https://github.com/owner/repo.git', ctx.work);

  expect(finding).toStrictEqual({
    ok: false,
    code: 'credential_in_url',
    message:
      'a url.<base>.insteadOf rewrite in the host git config puts a credential into the repository URL; remove the rewrite or pass the credential as a credentialRef',
  });
});

test('it accepts a URL an insteadOf rewrite expands into one without a token', async () => {
  const ctx = await setupTest();

  await $`git config url.https://mirror.example.com/.insteadOf https://github.com/`
    .env(ctx.env)
    .cwd(ctx.work)
    .quiet();

  const finding = await checkURLCredentials('https://github.com/owner/repo.git', ctx.work);

  expect(finding).toStrictEqual({ ok: true });
});
