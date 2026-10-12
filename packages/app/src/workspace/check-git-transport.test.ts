import { expect, test } from 'bun:test';
import { DEFAULT_GIT_TRANSPORTS } from '../shared/default-git-transports';
import { checkGitTransport } from './check-git-transport';

test.each([
  ['https://github.com/acme/app.git'],
  ['ssh://git@github.com/acme/app.git'],
  ['git+ssh://git@github.com/acme/app.git'],
  ['git@github.com:acme/app.git'],
  ['github.com:acme/app.git'],
])('it allows %p by default', (url) => {
  expect(checkGitTransport(url, DEFAULT_GIT_TRANSPORTS)).toStrictEqual({ ok: true });
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
  expect(checkGitTransport(url, DEFAULT_GIT_TRANSPORTS)).toStrictEqual({
    ok: false,
    code: 'invalid_git_url',
    message: `git transport '${transport}' is not allowed; the daemon fetches over https and ssh`,
  });
});

test('it allows a transport it is given beyond the defaults', () => {
  expect(checkGitTransport('/srv/git/app.git', ['https', 'file'])).toStrictEqual({ ok: true });
});

test('it refuses a default transport it is not given', () => {
  expect(checkGitTransport('ssh://git@github.com/acme/app.git', ['https', 'file'])).toStrictEqual({
    ok: false,
    code: 'invalid_git_url',
    message: "git transport 'ssh' is not allowed; the daemon fetches over https and file",
  });
});

test('it refuses a URL git could read as an option', () => {
  expect(checkGitTransport('--upload-pack=touch /tmp/x', ['https', 'ssh', 'file'])).toStrictEqual({
    ok: false,
    code: 'invalid_git_url',
    message: 'a git URL must not start with -',
  });
});

test('it refuses every URL when no transports are allowed', () => {
  expect(checkGitTransport('https://github.com/acme/app.git', [])).toStrictEqual({
    ok: false,
    code: 'invalid_git_url',
    message: "git transport 'https' is not allowed; workspaces.gitTransports allows no transports",
  });
});
