import { expect, test } from 'bun:test';
import { buildMockSortableSessionView } from '../test-utils/build-mock-sortable-session-view';
import { sortGroupedSessionViews } from './sort-grouped-session-views';

test('it clusters sessions sharing a repository even when states interleave', () => {
  const fleet = [
    {
      ...buildMockSortableSessionView({ id: 'a', state: 'running', lastAttachedAt: 1 }),
      repoRoot: '/repo/pocketknife',
    },
    {
      ...buildMockSortableSessionView({ id: 'b', state: 'running', lastAttachedAt: 2 }),
      repoRoot: '/repo/spicers',
    },
    {
      ...buildMockSortableSessionView({ id: 'c', state: 'needs_you', lastAttachedAt: 3 }),
      repoRoot: '/repo/pocketknife',
    },
    {
      ...buildMockSortableSessionView({ id: 'd', state: 'done', lastAttachedAt: 4 }),
      repoRoot: '/repo/spicers',
    },
    {
      ...buildMockSortableSessionView({ id: 'e', state: 'running', lastAttachedAt: 5 }),
      repoRoot: '/repo/pocketknife',
    },
  ];

  const ids = sortGroupedSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['c', 'e', 'a', 'd', 'b']);
});

test('it orders repository clusters by their most urgent member', () => {
  const fleet = [
    {
      ...buildMockSortableSessionView({ id: 'calm', state: 'running', lastAttachedAt: 9 }),
      repoRoot: '/repo/alpha',
    },
    {
      ...buildMockSortableSessionView({ id: 'urgent', state: 'needs_you', lastAttachedAt: 1 }),
      repoRoot: '/repo/beta',
    },
  ];

  const ids = sortGroupedSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['urgent', 'calm']);
});

test('it pulls pinned sessions out of their repositories into a leading cluster', () => {
  const fleet = [
    {
      ...buildMockSortableSessionView({ id: 'worker', state: 'needs_you', lastAttachedAt: 9 }),
      repoRoot: '/repo/alpha',
    },
    {
      ...buildMockSortableSessionView({
        id: 'starred',
        state: 'running',
        pinned: true,
        lastAttachedAt: 1,
      }),
      repoRoot: '/repo/alpha',
    },
  ];

  const ids = sortGroupedSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['starred', 'worker']);
});

test('it groups a sub-session under its parent repository, not its own', () => {
  const fleet = [
    {
      ...buildMockSortableSessionView({ id: 'wrangler', state: 'running', lastAttachedAt: 1 }),
      repoRoot: '/repo/alpha',
    },
    {
      ...buildMockSortableSessionView({
        id: 'worker',
        parent: 'wrangler',
        state: 'running',
        lastAttachedAt: 2,
      }),
      repoRoot: '/repo/beta',
    },
    {
      ...buildMockSortableSessionView({ id: 'other', state: 'running', lastAttachedAt: 3 }),
      repoRoot: '/repo/beta',
    },
  ];

  const ids = sortGroupedSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['other', 'wrangler', 'worker']);
});
