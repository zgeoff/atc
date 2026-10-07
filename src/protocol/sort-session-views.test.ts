import { expect, test } from 'bun:test';
import { sortSessionViews } from './sort-session-views';
import type { SortableSessionView } from './sortable-session-view';

test('it leads with pinned sessions in most-recently-attached order', () => {
  const fleet: SortableSessionView[] = [
    { id: 'busy', parent: null, state: 'running', pinned: false, lastAttachedAt: 9, createdAt: 9 },
    {
      id: 'pinned-old',
      parent: null,
      state: 'running',
      pinned: true,
      lastAttachedAt: 1,
      createdAt: 1,
    },
    {
      id: 'urgent',
      parent: null,
      state: 'needs_you',
      pinned: false,
      lastAttachedAt: 5,
      createdAt: 5,
    },
    {
      id: 'pinned-new',
      parent: null,
      state: 'done',
      pinned: true,
      lastAttachedAt: 2,
      createdAt: 2,
    },
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['pinned-new', 'pinned-old', 'urgent', 'busy']);
});

test('it orders unpinned sessions by urgency, then most recently attached', () => {
  const fleet: SortableSessionView[] = [
    { id: 'dead', parent: null, state: 'exited', pinned: false, lastAttachedAt: 9, createdAt: 9 },
    {
      id: 'busy-stale',
      parent: null,
      state: 'running',
      pinned: false,
      lastAttachedAt: 1,
      createdAt: 1,
    },
    {
      id: 'busy-fresh',
      parent: null,
      state: 'running',
      pinned: false,
      lastAttachedAt: 8,
      createdAt: 8,
    },
    { id: 'finished', parent: null, state: 'done', pinned: false, lastAttachedAt: 2, createdAt: 2 },
    {
      id: 'urgent',
      parent: null,
      state: 'needs_you',
      pinned: false,
      lastAttachedAt: 3,
      createdAt: 3,
    },
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['urgent', 'finished', 'busy-fresh', 'busy-stale', 'dead']);
});

test('it lists a sub-session directly under its parent', () => {
  const fleet: SortableSessionView[] = [
    { id: 'other', parent: null, state: 'running', pinned: false, lastAttachedAt: 9, createdAt: 9 },
    {
      id: 'worker',
      parent: 'wrangler',
      state: 'running',
      pinned: false,
      lastAttachedAt: 8,
      createdAt: 8,
    },
    {
      id: 'wrangler',
      parent: null,
      state: 'running',
      pinned: false,
      lastAttachedAt: 1,
      createdAt: 1,
    },
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['other', 'wrangler', 'worker']);
});

test('it never moves a parent for the attention of its sub-sessions', () => {
  const fleet: SortableSessionView[] = [
    { id: 'other', parent: null, state: 'done', pinned: false, lastAttachedAt: 9, createdAt: 9 },
    {
      id: 'worker',
      parent: 'wrangler',
      state: 'needs_you',
      pinned: false,
      lastAttachedAt: 8,
      createdAt: 8,
    },
    {
      id: 'wrangler',
      parent: null,
      state: 'running',
      pinned: false,
      lastAttachedAt: 1,
      createdAt: 1,
    },
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['other', 'wrangler', 'worker']);
});

test('it orders sub-sessions by urgency among their siblings', () => {
  const fleet: SortableSessionView[] = [
    {
      id: 'wrangler',
      parent: null,
      state: 'running',
      pinned: false,
      lastAttachedAt: 1,
      createdAt: 1,
    },
    {
      id: 'idle',
      parent: 'wrangler',
      state: 'running',
      pinned: false,
      lastAttachedAt: 3,
      createdAt: 3,
    },
    {
      id: 'urgent',
      parent: 'wrangler',
      state: 'needs_you',
      pinned: false,
      lastAttachedAt: 2,
      createdAt: 2,
    },
    {
      id: 'finished',
      parent: 'wrangler',
      state: 'done',
      pinned: false,
      lastAttachedAt: 4,
      createdAt: 4,
    },
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['wrangler', 'urgent', 'finished', 'idle']);
});

test('it ranks a sub-session whose parent is not listed as a top-level row', () => {
  const fleet: SortableSessionView[] = [
    { id: 'busy', parent: null, state: 'running', pinned: false, lastAttachedAt: 9, createdAt: 9 },
    {
      id: 'orphan',
      parent: 'gone',
      state: 'needs_you',
      pinned: false,
      lastAttachedAt: 1,
      createdAt: 1,
    },
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['orphan', 'busy']);
});

test('it keeps a pinned parent and its sub-sessions together at the top', () => {
  const fleet: SortableSessionView[] = [
    {
      id: 'urgent',
      parent: null,
      state: 'needs_you',
      pinned: false,
      lastAttachedAt: 9,
      createdAt: 9,
    },
    {
      id: 'worker',
      parent: 'wrangler',
      state: 'running',
      pinned: false,
      lastAttachedAt: 8,
      createdAt: 8,
    },
    {
      id: 'wrangler',
      parent: null,
      state: 'running',
      pinned: true,
      lastAttachedAt: 1,
      createdAt: 1,
    },
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['wrangler', 'worker', 'urgent']);
});
