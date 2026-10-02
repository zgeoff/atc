import { expect, test } from 'bun:test';
import { normalizeGitURL } from './normalize-git-url';

test.each([
  [
    'https://x-access-token:ghp_secret@github.com/zgeoff/atc.git',
    'https://github.com/zgeoff/atc.git',
  ],
  ['https://ghp_secret@github.com/zgeoff/atc.git', 'https://github.com/zgeoff/atc.git'],
  ['http://user:pass@git.example.com/repo.git', 'http://git.example.com/repo.git'],
  [
    'https://github.com/zgeoff/atc.git?access_token=secret#frag',
    'https://github.com/zgeoff/atc.git',
  ],
  ['ssh://git:secret@github.com:22/zgeoff/atc.git', 'ssh://git@github.com:22/zgeoff/atc.git'],
  ['ssh://git@github.com/zgeoff/atc.git', 'ssh://git@github.com/zgeoff/atc.git'],
  ['git@github.com:zgeoff/atc.git', 'git@github.com:zgeoff/atc.git'],
  ['github.com:zgeoff/atc.git', 'github.com:zgeoff/atc.git'],
  ['zgeoff/atc', 'https://github.com/zgeoff/atc.git'],
  ['zgeoff/atc.git', 'https://github.com/zgeoff/atc.git'],
  ['/srv/git/atc.git', '/srv/git/atc.git'],
  ['file:///srv/git/atc.git', 'file:///srv/git/atc.git'],
])('it normalizes %p to %p', (raw, url) => {
  expect(normalizeGitURL(raw)).toStrictEqual({ ok: true, url });
});

test.each([
  '',
  'not a url',
  './relative/path',
  'user:secret@host:owner/repo',
  'https://exa mple.com/x',
])('it refuses %p as a repository URL', (raw) => {
  expect(normalizeGitURL(raw)).toMatchObject({ ok: false, code: 'invalid_git_url' });
});
