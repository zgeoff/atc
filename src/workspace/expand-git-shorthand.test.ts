import { expect, test } from 'bun:test';
import { expandGitShorthand } from './expand-git-shorthand';

test.each([
  ['zgeoff/atc', 'https://github.com/zgeoff/atc.git'],
  ['zgeoff/atc.git', 'https://github.com/zgeoff/atc.git'],
  ['https://gitlab.com/acme/app.git', 'https://gitlab.com/acme/app.git'],
  ['git@github.com:zgeoff/atc.git', 'git@github.com:zgeoff/atc.git'],
  ['/srv/git/atc.git', '/srv/git/atc.git'],
  ['./relative/path', './relative/path'],
  ['.hidden/repo', '.hidden/repo'],
])('it expands %p to %p', (raw, url) => {
  expect(expandGitShorthand(raw)).toBe(url);
});
