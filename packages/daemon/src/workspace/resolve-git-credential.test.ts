import { expect, test } from 'bun:test';
import { resolveGitCredential } from './resolve-git-credential';

test('it resolves no credential when the source names none', () => {
  expect(
    resolveGitCredential(undefined, 'https://github.com/acme/app.git', new Map()),
  ).toStrictEqual({ ok: true, credential: undefined });
});

test.each([
  ['https://github.com/acme/app.git'],
  ['https://GitHub.com/acme/app.git'],
  ['https://github.com:443/acme/app.git'],
  ['https://x-access-token@github.com/acme/app.git'],
])('it resolves a listed credential for %s on a listed host', (url) => {
  expect(
    resolveGitCredential(
      { kind: 'env', name: 'CLONE_TOKEN' },
      url,
      new Map([['CLONE_TOKEN', ['github.com']]]),
    ),
  ).toStrictEqual({
    ok: true,
    credential: { kind: 'env', name: 'CLONE_TOKEN', hosts: ['github.com'] },
  });
});

test('it resolves a listed credential for a host listed with its port', () => {
  expect(
    resolveGitCredential(
      { kind: 'env', name: 'CLONE_TOKEN' },
      'http://127.0.0.1:8080/upstream.git',
      new Map([['CLONE_TOKEN', ['127.0.0.1:8080']]]),
    ),
  ).toStrictEqual({
    ok: true,
    credential: { kind: 'env', name: 'CLONE_TOKEN', hosts: ['127.0.0.1:8080'] },
  });
});

test('it refuses a credential the config does not list', () => {
  expect(
    resolveGitCredential(
      { kind: 'env', name: 'OTHER_TOKEN' },
      'https://github.com/acme/app.git',
      new Map([['CLONE_TOKEN', ['github.com']]]),
    ),
  ).toStrictEqual({
    ok: false,
    code: 'bad_args',
    message:
      "workspaces.gitCredentials in the daemon's config does not list the credentialRef OTHER_TOKEN",
  });
});

test.each([
  ['https://git.example.test/acme/app.git', 'git.example.test'],
  ['https://github.com.example.test/acme/app.git', 'github.com.example.test'],
  ['https://github.com:8443/acme/app.git', 'github.com:8443'],
])('it refuses a listed credential for %s, a host the config does not list', (url, host) => {
  expect(
    resolveGitCredential(
      { kind: 'env', name: 'CLONE_TOKEN' },
      url,
      new Map([['CLONE_TOKEN', ['github.com']]]),
    ),
  ).toStrictEqual({
    ok: false,
    code: 'bad_args',
    message: `workspaces.gitCredentials in the daemon's config does not allow the credentialRef CLONE_TOKEN for ${host}`,
  });
});

test.each([
  ['ssh://git@github.com/acme/app.git'],
  ['git@github.com:acme/app.git'],
  ['file:///srv/git/app.git'],
  ['/srv/git/app.git'],
  ['not a url'],
])('it refuses a listed credential for %s, which is not an https or http URL', (url) => {
  expect(
    resolveGitCredential(
      { kind: 'env', name: 'CLONE_TOKEN' },
      url,
      new Map([['CLONE_TOKEN', ['github.com']]]),
    ),
  ).toStrictEqual({
    ok: false,
    code: 'bad_args',
    message: 'a credentialRef is sent only with an https or http repository URL',
  });
});
