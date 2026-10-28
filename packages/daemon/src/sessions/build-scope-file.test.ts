import { expect, test } from 'bun:test';
import { buildMockPublishedRecord } from '@atc/test-utils';
import { buildScopeFile } from './build-scope-file';

test("it declares the record's checkouts, branches, pull requests, scratch folder, and spawner", () => {
  const record = buildMockPublishedRecord({
    spawner: 's-lead',
    scratch: '/srv/state/sessions/s-1/scratch',
    scope: {
      workspace: {
        path: '/src/shop',
        branch: 'main',
        repoURL: 'https://github.com/example-org/shop.git',
        sha: 'c'.repeat(40),
      },
      worktrees: [{ path: '/src/shop/.worktrees/cart-totals', branch: 'cart-totals' }],
      branches: [{ name: 'cart-totals', repo: '/src/shop' }],
      pullRequests: [
        {
          repo: 'example-org/shop',
          number: 41,
          url: 'https://github.com/example-org/shop/pull/41',
          branch: 'cart-totals',
        },
      ],
    },
  });

  expect(buildScopeFile(record)).toStrictEqual({
    format: 'auto-mode.scope',
    version: 1,
    paths: ['/srv/state/sessions/s-1/scratch'],
    workspace: { path: '/src/shop', branch: 'main' },
    worktrees: [{ path: '/src/shop/.worktrees/cart-totals', branch: 'cart-totals' }],
    branches: [{ name: 'cart-totals', repo: '/src/shop' }],
    pullRequests: [
      {
        repo: 'example-org/shop',
        number: 41,
        branch: 'cart-totals',
        url: 'https://github.com/example-org/shop/pull/41',
      },
    ],
    replyChannels: [{ tool: 'mcp__atc__atc_message_send', field: 'session', recipient: 's-lead' }],
  });
});

test('it declares no owned path and no reply channel for a record without a scratch folder or a spawner', () => {
  const record = buildMockPublishedRecord({ spawner: null, scratch: null });
  const scopeFile = buildScopeFile(record);

  expect(scopeFile.paths).toStrictEqual([]);
  expect(scopeFile.replyChannels).toStrictEqual([]);
});
