import { expect, test } from 'bun:test';
import { WORKSPACE_CLEANUP_SCHEMA } from './workspace-cleanup';

test('it accepts a removed workspace with the work it found', () => {
  const result = WORKSPACE_CLEANUP_SCHEMA.safeParse({
    outcome: 'removed',
    path: '/srv/work/bakery-9',
    found: ['1 unpushed commit on a detached HEAD'],
  });

  expect(result.data).toStrictEqual({
    outcome: 'removed',
    path: '/srv/work/bakery-9',
    found: ['1 unpushed commit on a detached HEAD'],
  });
});

test('it accepts a kept workspace with its reasons', () => {
  const result = WORKSPACE_CLEANUP_SCHEMA.safeParse({
    outcome: 'kept',
    path: '/srv/work/bakery-9',
    reasons: ['2 stashes'],
  });

  expect(result.data).toStrictEqual({
    outcome: 'kept',
    path: '/srv/work/bakery-9',
    reasons: ['2 stashes'],
  });
});

test('it rejects a removed workspace whose found entry is not text', () => {
  const result = WORKSPACE_CLEANUP_SCHEMA.safeParse({
    outcome: 'removed',
    path: '/srv/work/bakery-9',
    found: [3],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['found', 0] });
});

test('it rejects a kept workspace whose reason is not text', () => {
  const result = WORKSPACE_CLEANUP_SCHEMA.safeParse({
    outcome: 'kept',
    path: '/srv/work/bakery-9',
    reasons: [3],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['reasons', 0] });
});
