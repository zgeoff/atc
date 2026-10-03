import { expect, test } from 'bun:test';
import { findGitHubAlternateURL } from './find-github-alternate-url';

test.each([
  ['https://github.com/acme/app.git', 'git@github.com:acme/app.git'],
  ['https://github.com/acme/app', 'git@github.com:acme/app.git'],
  ['acme/app', null],
  ['git@github.com:acme/app.git', 'https://github.com/acme/app.git'],
  ['ssh://git@github.com/acme/app.git', 'https://github.com/acme/app.git'],
  ['https://gitlab.com/acme/app.git', null],
  ['/srv/git/app.git', null],
] as const)('it finds the other form of %p as %p', (url, expected) => {
  expect(findGitHubAlternateURL(url)).toBe(expected);
});
