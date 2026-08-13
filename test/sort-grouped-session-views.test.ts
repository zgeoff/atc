import { expect, test } from 'bun:test';
import type { SessionState } from '../src/sessions';
import { sortGroupedSessionViews } from '../src/sessions';

interface View {
  readonly id: string;
  readonly state: SessionState;
  readonly createdAt: number;
  readonly group?: string;
  readonly cwd: string;
}

function buildView(id: string, state: SessionState, createdAt: number, group?: string): View {
  return { id, state, createdAt, cwd: `/repo/${id}`, ...(group === undefined ? {} : { group }) };
}

test('sessions sharing a group are adjacent even when states interleave', () => {
  const fleet = [
    buildView('a', 'running', 1, 'pocketknife'),
    buildView('b', 'running', 2, 'spicers'),
    buildView('c', 'needs_you', 3, 'pocketknife'),
    buildView('d', 'done', 4, 'spicers'),
    buildView('e', 'running', 5, 'pocketknife'),
  ];

  const ids = sortGroupedSessionViews(fleet).map((s) => s.id);

  expect(ids).toEqual(['c', 'a', 'e', 'd', 'b']);
});

test('groups are ordered by their most urgent member', () => {
  const fleet = [
    buildView('calm', 'running', 1, 'alpha'),
    buildView('urgent', 'needs_you', 2, 'beta'),
  ];

  const ids = sortGroupedSessionViews(fleet).map((s) => s.id);

  expect(ids).toEqual(['urgent', 'calm']);
});

test('ungrouped sessions cluster by spawn directory', () => {
  const shared = { state: 'running' as const, cwd: '/repo/shared' };

  const fleet = [
    { id: 'x', createdAt: 1, ...shared },
    buildView('y', 'running', 2, 'alpha'),
    { id: 'z', createdAt: 3, ...shared },
  ];

  const ids = sortGroupedSessionViews(fleet).map((s) => s.id);

  expect(ids).toEqual(['x', 'z', 'y']);
});

test('within a group the urgency order survives', () => {
  const fleet = [
    buildView('late-needy', 'needs_you', 9, 'alpha'),
    buildView('early-busy', 'running', 1, 'alpha'),
    buildView('early-done', 'done', 2, 'alpha'),
  ];

  const ids = sortGroupedSessionViews(fleet).map((s) => s.id);

  expect(ids).toEqual(['late-needy', 'early-done', 'early-busy']);
});
