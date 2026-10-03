import { expect, test } from 'bun:test';
import { findAlternateGitURL } from './find-alternate-git-url';

test.each([
  ['https://github.com/acme/app.git', 'git@github.com:acme/app.git'],
  ['https://github.com/acme/app', 'git@github.com:acme/app.git'],
  ['acme/app', 'git@github.com:acme/app.git'],
  ['git@github.com:acme/app.git', 'https://github.com/acme/app.git'],
  ['ssh://git@github.com/acme/app.git', 'https://github.com/acme/app.git'],
  ['https://gitlab.com/acme/app.git', null],
  ['/srv/git/app.git', null],
] as const)('it finds the other form of %p as %p', (url, expected) => {
  expect(findAlternateGitURL(url)).toBe(expected);
});
