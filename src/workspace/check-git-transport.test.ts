import { expect, test } from 'bun:test';
import { updateEnv } from '../../test/update-env';
import { checkGitTransport } from './check-git-transport';

test.each([
  ['https://github.com/acme/app.git'],
  ['ssh://git@github.com/acme/app.git'],
  ['git+ssh://git@github.com/acme/app.git'],
  ['git@github.com:acme/app.git'],
  ['github.com:acme/app.git'],
])('it allows %p by default', (url) => {
  updateEnv('ATC_GIT_ALLOW_PROTOCOL', undefined);

  expect(checkGitTransport(url)).toStrictEqual({ ok: true });
});

test.each([
  ['http://example.com/app.git', 'http'],
  ['git://example.com/app.git', 'git'],
  ['file:///srv/git/app.git', 'file'],
  ['/srv/git/app.git', 'file'],
  ['./app.git', 'file'],
  ['ext::sh -c touch% /tmp/x', 'ext'],
  ['fd::17', 'fd'],
])('it refuses %p as the %p transport by default', (url, transport) => {
  updateEnv('ATC_GIT_ALLOW_PROTOCOL', undefined);

  expect(checkGitTransport(url)).toStrictEqual({
    ok: false,
    code: 'invalid_git_url',
    message: `git transport '${transport}' is not allowed; atc fetches over https and ssh`,
  });
});

test('it allows the transports the environment adds, but never ext or fd', () => {
  updateEnv('ATC_GIT_ALLOW_PROTOCOL', 'https:file:ext:fd');

  expect(checkGitTransport('/srv/git/app.git')).toStrictEqual({ ok: true });
  expect(checkGitTransport('ext::sh -c id')).toMatchObject({ ok: false });
  expect(checkGitTransport('fd::17')).toMatchObject({ ok: false });
  expect(checkGitTransport('ssh://git@github.com/acme/app.git')).toMatchObject({ ok: false });
});

test('it refuses a URL git could read as an option', () => {
  expect(checkGitTransport('--upload-pack=touch /tmp/x')).toStrictEqual({
    ok: false,
    code: 'invalid_git_url',
    message: 'a git URL must not start with -',
  });
});
