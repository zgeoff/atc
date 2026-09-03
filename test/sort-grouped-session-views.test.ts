import { expect, test } from 'bun:test';
import type { SessionState } from '../src/daemon/sessions';
import { sortGroupedSessionViews, sortSessionViews } from '../src/daemon/sessions';

interface View {
  readonly id: string;
  readonly parent: string | null;
  readonly state: SessionState;
  readonly pinned: boolean;
  readonly lastAttachedAt: number;
  readonly createdAt: number;
  readonly repoRoot: string;
}

function buildView(
  id: string,
  state: SessionState,
  lastAttachedAt: number,
  overrides: Partial<Pick<View, 'pinned' | 'repoRoot' | 'parent'>> = {},
): View {
  return {
    id,
    parent: overrides.parent ?? null,
    state,
    pinned: overrides.pinned ?? false,
    lastAttachedAt,
    createdAt: lastAttachedAt,
    repoRoot: overrides.repoRoot ?? `/repo/${id}`,
  };
}

test('it leads with pinned sessions in most-recently-attached order', () => {
  const fleet = [
    buildView('busy', 'running', 9),
    buildView('pinned-old', 'running', 1, { pinned: true }),
    buildView('urgent', 'needs_you', 5),
    buildView('pinned-new', 'done', 2, { pinned: true }),
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toEqual(['pinned-new', 'pinned-old', 'urgent', 'busy']);
});

test('it orders unpinned sessions by urgency, then most recently attached', () => {
  const fleet = [
    buildView('dead', 'exited', 9),
    buildView('busy-stale', 'running', 1),
    buildView('busy-fresh', 'running', 8),
    buildView('finished', 'done', 2),
    buildView('urgent', 'needs_you', 3),
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toEqual(['urgent', 'finished', 'busy-fresh', 'busy-stale', 'dead']);
});

test('it clusters sessions sharing a repository even when states interleave', () => {
  const fleet = [
    buildView('a', 'running', 1, { repoRoot: '/repo/pocketknife' }),
    buildView('b', 'running', 2, { repoRoot: '/repo/spicers' }),
    buildView('c', 'needs_you', 3, { repoRoot: '/repo/pocketknife' }),
    buildView('d', 'done', 4, { repoRoot: '/repo/spicers' }),
    buildView('e', 'running', 5, { repoRoot: '/repo/pocketknife' }),
  ];

  const ids = sortGroupedSessionViews(fleet).map((s) => s.id);

  expect(ids).toEqual(['c', 'e', 'a', 'd', 'b']);
});

test('it orders repository clusters by their most urgent member', () => {
  const fleet = [
    buildView('calm', 'running', 9, { repoRoot: '/repo/alpha' }),
    buildView('urgent', 'needs_you', 1, { repoRoot: '/repo/beta' }),
  ];

  const ids = sortGroupedSessionViews(fleet).map((s) => s.id);

  expect(ids).toEqual(['urgent', 'calm']);
});

test('it pulls pinned sessions out of their repositories into a leading cluster', () => {
  const fleet = [
    buildView('worker', 'needs_you', 9, { repoRoot: '/repo/alpha' }),
    buildView('starred', 'running', 1, { pinned: true, repoRoot: '/repo/alpha' }),
  ];

  const ids = sortGroupedSessionViews(fleet).map((s) => s.id);

  expect(ids).toEqual(['starred', 'worker']);
});

test('it lists a sub-session directly under its parent', () => {
  const fleet = [
    buildView('other', 'running', 9),
    buildView('worker', 'running', 8, { parent: 'wrangler' }),
    buildView('wrangler', 'running', 1),
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toEqual(['other', 'wrangler', 'worker']);
});

test('it never moves a parent for the attention of its sub-sessions', () => {
  const fleet = [
    buildView('other', 'done', 9),
    buildView('worker', 'needs_you', 8, { parent: 'wrangler' }),
    buildView('wrangler', 'running', 1),
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toEqual(['other', 'wrangler', 'worker']);
});

test('it orders sub-sessions by urgency among their siblings', () => {
  const fleet = [
    buildView('wrangler', 'running', 1),
    buildView('idle', 'running', 3, { parent: 'wrangler' }),
    buildView('urgent', 'needs_you', 2, { parent: 'wrangler' }),
    buildView('finished', 'done', 4, { parent: 'wrangler' }),
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toEqual(['wrangler', 'urgent', 'finished', 'idle']);
});

test('it ranks a sub-session whose parent is not listed as a top-level row', () => {
  const fleet = [
    buildView('busy', 'running', 9),
    buildView('orphan', 'needs_you', 1, { parent: 'gone' }),
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toEqual(['orphan', 'busy']);
});

test('it keeps a pinned parent and its sub-sessions together at the top', () => {
  const fleet = [
    buildView('urgent', 'needs_you', 9),
    buildView('worker', 'running', 8, { parent: 'wrangler' }),
    buildView('wrangler', 'running', 1, { pinned: true }),
  ];

  const ids = sortSessionViews(fleet).map((s) => s.id);

  expect(ids).toEqual(['wrangler', 'worker', 'urgent']);
});

test('it groups a sub-session under its parent repository, not its own', () => {
  const fleet = [
    buildView('wrangler', 'running', 1, { repoRoot: '/repo/alpha' }),
    buildView('worker', 'running', 2, { parent: 'wrangler', repoRoot: '/repo/beta' }),
    buildView('other', 'running', 3, { repoRoot: '/repo/beta' }),
  ];

  const ids = sortGroupedSessionViews(fleet).map((s) => s.id);

  expect(ids).toEqual(['other', 'wrangler', 'worker']);
});
