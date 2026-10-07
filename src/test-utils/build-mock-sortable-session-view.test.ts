import { expect, test } from 'bun:test';
import { buildMockSortableSessionView } from './build-mock-sortable-session-view';

test('it builds a default sortable session view', () => {
  expect(buildMockSortableSessionView()).toStrictEqual({
    id: expect.toBeString(),
    parent: null,
    state: 'running',
    pinned: false,
    lastAttachedAt: expect.toBeNumber(),
    createdAt: expect.toBeNumber(),
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockSortableSessionView({
      id: 'worker',
      parent: 'wrangler',
      state: 'needs_you',
      pinned: true,
      lastAttachedAt: 9,
    }),
  ).toStrictEqual({
    id: 'worker',
    parent: 'wrangler',
    state: 'needs_you',
    pinned: true,
    lastAttachedAt: 9,
    createdAt: expect.toBeNumber(),
  });
});
