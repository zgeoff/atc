import { expect, test } from 'bun:test';
import { buildWorkspaceDestination } from './build-workspace-destination';

const SHA = 'c2e799e0123456789abcdef0123456789abcdef0';

test.each([
  ['https://github.com/acme/app.git', 'main', '/ws/app-main-c2e799e'],
  ['git@github.com:acme/app.git', 'feat/login', '/ws/app-feat-login-c2e799e'],
  ['/srv/git/upstream.git', 'v1.0', '/ws/upstream-v1.0-c2e799e'],
  ['https://example.com/acme/app/', 'we!rd ref', '/ws/app-werdref-c2e799e'],
  ['https://github.com/acme/app.git', null, '/ws/app-c2e799e'],
] as const)('it names the checkout of %p at %p as %p', (url, ref, expected) => {
  expect(buildWorkspaceDestination({ root: '/ws/', url, ref, sha: SHA })).toBe(expected);
});
