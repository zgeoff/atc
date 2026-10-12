import { expect, test } from 'bun:test';
import { buildWorkspaceDestination } from './build-workspace-destination';

test.each([
  [
    'https://github.com/acme/app.git',
    'main',
    'c2e799e0123456789abcdef0123456789abcdef0',
    '/ws/app-main-c2e799e',
  ],
  [
    'git@github.com:acme/app.git',
    'feat/login',
    'c2e799e0123456789abcdef0123456789abcdef0',
    '/ws/app-feat-login-c2e799e',
  ],
  [
    '/srv/git/upstream.git',
    'v1.0',
    'c2e799e0123456789abcdef0123456789abcdef0',
    '/ws/upstream-v1.0-c2e799e',
  ],
  [
    'https://example.com/acme/app/',
    'we!rd ref',
    'c2e799e0123456789abcdef0123456789abcdef0',
    '/ws/app-werdref-c2e799e',
  ],
  [
    'https://github.com/acme/app.git',
    null,
    'c2e799e0123456789abcdef0123456789abcdef0',
    '/ws/app-c2e799e',
  ],
] as const)('it names the checkout of %p at %p and commit %p as %p', (url, ref, sha, expected) => {
  expect(buildWorkspaceDestination({ root: '/ws/', url, ref, sha })).toBe(expected);
});
