import { expect, test } from 'bun:test';
import { $ } from 'bun';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { checkURLCredentials } from './check-url-credentials';

// A repository whose own config holds the rewrites a test adds, with the
// host's system and global config kept out of every fixture command.
async function setupTest() {
  const tmp = setupTempDir('atc-url-credentials-');

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };

  await $`git init --quiet --template= ${tmp.dir}`.env(env).quiet();

  return {
    env,
    dir: tmp.dir,
    [Symbol.dispose]: tmp[Symbol.dispose],
  };
}

test.each([
  ['an https URL', 'https://github.com/owner/repo.git'],
  ['an ssh URL with a login user', 'ssh://git@github.com/owner/repo.git'],
  ['an scp-style URL', 'git@github.com:owner/repo.git'],
  ['a local path', '/srv/git/repo.git'],
])('it accepts %s that carries no credential', async (_, url) => {
  using repo = await setupTest();

  const finding = await checkURLCredentials(url, repo.dir);

  expect(finding).toStrictEqual({ ok: true });
});

test.each([
  ['userinfo', 'https://x-access-token:tok-1@github.com/owner/repo.git'],
  ['a bare user', 'https://tok-1@github.com/owner/repo.git'],
  ['a query', 'https://github.com/owner/repo.git?private_token=tok-1'],
  ['a fragment', 'https://github.com/owner/repo.git#tok-1'],
  ['an ssh password', 'ssh://git:tok-1@github.com/owner/repo.git'],
])('it refuses a URL whose %s carries a credential', async (_, url) => {
  using repo = await setupTest();

  const finding = await checkURLCredentials(url, repo.dir);

  expect(finding).toMatchObject({ ok: false, code: 'credential_in_url' });
});

test('it refuses a URL an insteadOf rewrite expands into one with a token', async () => {
  using repo = await setupTest();

  await $`git config url.https://x-access-token:tok-1@github.com/.insteadOf https://github.com/`
    .env(repo.env)
    .cwd(repo.dir)
    .quiet();

  const finding = await checkURLCredentials('https://github.com/owner/repo.git', repo.dir);

  expect(finding).toMatchObject({ ok: false, code: 'credential_in_url' });
});

test('it accepts a URL an insteadOf rewrite expands into one without a token', async () => {
  using repo = await setupTest();

  await $`git config url.https://mirror.example.com/.insteadOf https://github.com/`
    .env(repo.env)
    .cwd(repo.dir)
    .quiet();

  const finding = await checkURLCredentials('https://github.com/owner/repo.git', repo.dir);

  expect(finding).toStrictEqual({ ok: true });
});
