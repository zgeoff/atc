import { expect, test } from 'bun:test';
import { sortGroupedSessionViews } from './sort-grouped-session-views';
import type { SortableSessionView } from './sortable-session-view';

test('it clusters sessions sharing a repository even when states interleave', () => {
  const fleet: (SortableSessionView & { readonly repoRoot: string })[] = [
    {
      id: 'a',
      parent: null,
      state: 'running',
      pinned: false,
      lastAttachedAt: 1,
      createdAt: 1,
      repoRoot: '/repo/pocketknife',
    },
    {
      id: 'b',
      parent: null,
      state: 'running',
      pinned: false,
      lastAttachedAt: 2,
      createdAt: 2,
      repoRoot: '/repo/spicers',
    },
    {
      id: 'c',
      parent: null,
      state: 'needs_you',
      pinned: false,
      lastAttachedAt: 3,
      createdAt: 3,
      repoRoot: '/repo/pocketknife',
    },
    {
      id: 'd',
      parent: null,
      state: 'done',
      pinned: false,
      lastAttachedAt: 4,
      createdAt: 4,
      repoRoot: '/repo/spicers',
    },
    {
      id: 'e',
      parent: null,
      state: 'running',
      pinned: false,
      lastAttachedAt: 5,
      createdAt: 5,
      repoRoot: '/repo/pocketknife',
    },
  ];

  const ids = sortGroupedSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['c', 'e', 'a', 'd', 'b']);
});

test('it orders repository clusters by their most urgent member', () => {
  const fleet: (SortableSessionView & { readonly repoRoot: string })[] = [
    {
      id: 'calm',
      parent: null,
      state: 'running',
      pinned: false,
      lastAttachedAt: 9,
      createdAt: 9,
      repoRoot: '/repo/alpha',
    },
    {
      id: 'urgent',
      parent: null,
      state: 'needs_you',
      pinned: false,
      lastAttachedAt: 1,
      createdAt: 1,
      repoRoot: '/repo/beta',
    },
  ];

  const ids = sortGroupedSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['urgent', 'calm']);
});

test('it pulls pinned sessions out of their repositories into a leading cluster', () => {
  const fleet: (SortableSessionView & { readonly repoRoot: string })[] = [
    {
      id: 'worker',
      parent: null,
      state: 'needs_you',
      pinned: false,
      lastAttachedAt: 9,
      createdAt: 9,
      repoRoot: '/repo/alpha',
    },
    {
      id: 'starred',
      parent: null,
      state: 'running',
      pinned: true,
      lastAttachedAt: 1,
      createdAt: 1,
      repoRoot: '/repo/alpha',
    },
  ];

  const ids = sortGroupedSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['starred', 'worker']);
});

test('it groups a sub-session under its parent repository, not its own', () => {
  const fleet: (SortableSessionView & { readonly repoRoot: string })[] = [
    {
      id: 'wrangler',
      parent: null,
      state: 'running',
      pinned: false,
      lastAttachedAt: 1,
      createdAt: 1,
      repoRoot: '/repo/alpha',
    },
    {
      id: 'worker',
      parent: 'wrangler',
      state: 'running',
      pinned: false,
      lastAttachedAt: 2,
      createdAt: 2,
      repoRoot: '/repo/beta',
    },
    {
      id: 'other',
      parent: null,
      state: 'running',
      pinned: false,
      lastAttachedAt: 3,
      createdAt: 3,
      repoRoot: '/repo/beta',
    },
  ];

  const ids = sortGroupedSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['other', 'wrangler', 'worker']);
});
