import { expect, test } from 'bun:test';
import { buildMockSortableSessionView } from '../test-utils/build-mock-sortable-session-view';
import { sortSessionViews } from './sort-session-views';

test('it leads with pinned sessions in most-recently-attached order', () => {
  const fleet = [
    buildMockSortableSessionView({ id: 'busy', state: 'running', lastAttachedAt: 9 }),
    buildMockSortableSessionView({
      id: 'pinned-old',
      state: 'running',
      pinned: true,
      lastAttachedAt: 1,
    }),
    buildMockSortableSessionView({ id: 'urgent', state: 'needs_you', lastAttachedAt: 5 }),
    buildMockSortableSessionView({
      id: 'pinned-new',
      state: 'done',
      pinned: true,
      lastAttachedAt: 2,
    }),
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['pinned-new', 'pinned-old', 'urgent', 'busy']);
});

test('it orders unpinned sessions by urgency, then most recently attached', () => {
  const fleet = [
    buildMockSortableSessionView({ id: 'dead', state: 'exited', lastAttachedAt: 9 }),
    buildMockSortableSessionView({ id: 'busy-stale', state: 'running', lastAttachedAt: 1 }),
    buildMockSortableSessionView({ id: 'busy-fresh', state: 'running', lastAttachedAt: 8 }),
    buildMockSortableSessionView({ id: 'finished', state: 'done', lastAttachedAt: 2 }),
    buildMockSortableSessionView({ id: 'urgent', state: 'needs_you', lastAttachedAt: 3 }),
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['urgent', 'finished', 'busy-fresh', 'busy-stale', 'dead']);
});

test('it lists a sub-session directly under its parent', () => {
  const fleet = [
    buildMockSortableSessionView({ id: 'other', state: 'running', lastAttachedAt: 9 }),
    buildMockSortableSessionView({
      id: 'worker',
      parent: 'wrangler',
      state: 'running',
      lastAttachedAt: 8,
    }),
    buildMockSortableSessionView({ id: 'wrangler', state: 'running', lastAttachedAt: 1 }),
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['other', 'wrangler', 'worker']);
});

test('it never moves a parent for the attention of its sub-sessions', () => {
  const fleet = [
    buildMockSortableSessionView({ id: 'other', state: 'done', lastAttachedAt: 9 }),
    buildMockSortableSessionView({
      id: 'worker',
      parent: 'wrangler',
      state: 'needs_you',
      lastAttachedAt: 8,
    }),
    buildMockSortableSessionView({ id: 'wrangler', state: 'running', lastAttachedAt: 1 }),
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['other', 'wrangler', 'worker']);
});

test('it orders sub-sessions by urgency among their siblings', () => {
  const fleet = [
    buildMockSortableSessionView({ id: 'wrangler', state: 'running', lastAttachedAt: 1 }),
    buildMockSortableSessionView({
      id: 'idle',
      parent: 'wrangler',
      state: 'running',
      lastAttachedAt: 3,
    }),
    buildMockSortableSessionView({
      id: 'urgent',
      parent: 'wrangler',
      state: 'needs_you',
      lastAttachedAt: 2,
    }),
    buildMockSortableSessionView({
      id: 'finished',
      parent: 'wrangler',
      state: 'done',
      lastAttachedAt: 4,
    }),
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['wrangler', 'urgent', 'finished', 'idle']);
});

test('it ranks a sub-session whose parent is not listed as a top-level row', () => {
  const fleet = [
    buildMockSortableSessionView({ id: 'busy', state: 'running', lastAttachedAt: 9 }),
    buildMockSortableSessionView({
      id: 'orphan',
      parent: 'gone',
      state: 'needs_you',
      lastAttachedAt: 1,
    }),
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['orphan', 'busy']);
});

test('it keeps a pinned parent and its sub-sessions together at the top', () => {
  const fleet = [
    buildMockSortableSessionView({ id: 'urgent', state: 'needs_you', lastAttachedAt: 9 }),
    buildMockSortableSessionView({
      id: 'worker',
      parent: 'wrangler',
      state: 'running',
      lastAttachedAt: 8,
    }),
    buildMockSortableSessionView({
      id: 'wrangler',
      state: 'running',
      pinned: true,
      lastAttachedAt: 1,
    }),
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toStrictEqual(['wrangler', 'worker', 'urgent']);
});
