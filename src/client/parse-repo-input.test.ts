import { expect, test } from 'bun:test';
import { parseRepoInput } from './parse-repo-input';

test.each([
  ['https://github.com/acme/app.git', { kind: 'url', url: 'https://github.com/acme/app.git' }],
  ['ssh://git@host/acme/app.git', { kind: 'url', url: 'ssh://git@host/acme/app.git' }],
  ['git@github.com:acme/app.git', { kind: 'url', url: 'git@github.com:acme/app.git' }],
  ['/srv/git/app.git', { kind: 'url', url: '/srv/git/app.git' }],
  [' acme/app ', { kind: 'repo', nameWithOwner: 'acme/app' }],
  ['acme/app.git', { kind: 'repo', nameWithOwner: 'acme/app' }],
  ['acme/', { kind: 'owner', owner: 'acme' }],
  ['app', { kind: 'filter', text: 'app' }],
  ['', { kind: 'filter', text: '' }],
  ['~/src/app', { kind: 'filter', text: '~/src/app' }],
  ['./app', { kind: 'filter', text: './app' }],
] as const)('it reads %p as %p', (input, expected) => {
  expect(parseRepoInput(input)).toStrictEqual(expected);
});
