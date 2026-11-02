import { expect, test } from 'bun:test';
import { toSessionID } from '@atcx/contract';
import { pickWorkspaceCleanup } from './pick-workspace-cleanup';

test.each([['unpushed' as const], ['none' as const]])(
  'it removes a clean workspace under the %s check',
  (check) => {
    expect(
      pickWorkspaceCleanup({
        check,
        directory: '/srv/work/shop-main',
        result: { kind: 'checked', path: '/data/work/shop-main', findings: [] },
        user: null,
      }),
    ).toStrictEqual({ action: 'remove', path: '/data/work/shop-main', found: [] });
  },
);

test('it keeps a workspace that holds work under the unpushed check, one reason per finding', () => {
  expect(
    pickWorkspaceCleanup({
      check: 'unpushed',
      directory: '/srv/work/shop-main',
      result: {
        kind: 'checked',
        path: '/srv/work/shop-main',
        findings: ['1 stash', '2 unpushed commits on fix-login'],
      },
      user: null,
    }),
  ).toStrictEqual({
    action: 'keep',
    path: '/srv/work/shop-main',
    reasons: ['1 stash', '2 unpushed commits on fix-login'],
  });
});

test('it removes a workspace that holds work under the none check, and lists what it held', () => {
  expect(
    pickWorkspaceCleanup({
      check: 'none',
      directory: '/srv/work/shop-main',
      result: {
        kind: 'checked',
        path: '/srv/work/shop-main',
        findings: ['1 unpushed commit on main'],
      },
      user: null,
    }),
  ).toStrictEqual({
    action: 'remove',
    path: '/srv/work/shop-main',
    found: ['1 unpushed commit on main'],
  });
});

test.each([['unpushed' as const], ['none' as const]])(
  'it keeps a workspace another listed session uses under the %s check',
  (check) => {
    expect(
      pickWorkspaceCleanup({
        check,
        directory: '/srv/work/shop-main',
        result: { kind: 'checked', path: '/srv/work/shop-main', findings: [] },
        user: toSessionID('s-reviewer'),
      }),
    ).toStrictEqual({
      action: 'keep',
      path: '/srv/work/shop-main',
      reasons: ['in use by session s-reviewer'],
    });
  },
);

test.each([['unpushed' as const], ['none' as const]])(
  'it keeps a workspace the host left unchecked under the %s check',
  (check) => {
    expect(
      pickWorkspaceCleanup({
        check,
        directory: '/srv/work/shop-main',
        result: { kind: 'unchecked', reason: 'host did not answer' },
        user: null,
      }),
    ).toStrictEqual({
      action: 'keep',
      path: '/srv/work/shop-main',
      reasons: ['unchecked: host did not answer'],
    });
  },
);

test.each([['unpushed' as const], ['none' as const]])(
  'it keeps a folder that is not the checkout atc created under the %s check',
  (check) => {
    expect(
      pickWorkspaceCleanup({
        check,
        directory: '/srv/work/shop-main',
        result: { kind: 'foreign' },
        user: null,
      }),
    ).toStrictEqual({
      action: 'keep',
      path: '/srv/work/shop-main',
      reasons: ['not the checkout atc created: no git checkout of its commit is there'],
    });
  },
);

test('it skips a workspace folder that is already gone', () => {
  expect(
    pickWorkspaceCleanup({
      check: 'unpushed',
      directory: '/srv/work/shop-main',
      result: { kind: 'missing' },
      user: toSessionID('s-reviewer'),
    }),
  ).toStrictEqual({ action: 'skip' });
});
