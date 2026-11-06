import { expect, test } from 'bun:test';
import { toSessionID } from '@atcx/contract';
import { pickPruneWorkspacePlan } from './pick-prune-workspace-plan';

test.each([
  { mode: 'a prune with remove', remove: true, action: 'remove' },
  { mode: 'a dry run', remove: false, action: 'report' },
])('it plans to $action a clean workspace on $mode', (row) => {
  const plan = pickPruneWorkspacePlan({
    check: 'unpushed',
    directory: '/w/bakery',
    result: { kind: 'checked', path: '/srv/w/bakery', findings: [] },
    listed: [],
    storedDirs: [],
    remove: row.remove,
  });

  expect(plan).toStrictEqual({ action: row.action, path: '/srv/w/bakery', found: [] });
});

test.each([
  {
    user: 'a session on the machine that runs inside it',
    listed: [{ id: 'plain', cwd: '/w/bakery/src', onMachine: true }],
    storedDirs: [],
    reason: 'in use by session plain',
  },
  {
    user: 'a session on the machine that runs inside its resolved path',
    listed: [{ id: 'plain', cwd: '/srv/w/bakery', onMachine: true }],
    storedDirs: [],
    reason: 'in use by session plain',
  },
  {
    user: 'a stored session whose directory resolves inside it',
    listed: [],
    storedDirs: [{ id: 'stored', physical: '/srv/w/bakery/src' }],
    reason: 'in use by session stored',
  },
  {
    user: 'a stored session whose directory did not resolve',
    listed: [],
    storedDirs: [{ id: 'stored', physical: null }],
    reason: 'in use by session stored',
  },
])('it keeps a clean workspace that $user uses', (row) => {
  const plan = pickPruneWorkspacePlan({
    check: 'none',
    directory: '/w/bakery',
    result: { kind: 'checked', path: '/srv/w/bakery', findings: [] },
    listed: row.listed.map((session) => ({ ...session, id: toSessionID(session.id) })),
    storedDirs: row.storedDirs.map((stored) => ({ ...stored, id: toSessionID(stored.id) })),
    remove: true,
  });

  expect(plan).toStrictEqual({ action: 'keep', path: '/srv/w/bakery', reasons: [row.reason] });
});

test('it removes a workspace whose path only a session on another machine runs in', () => {
  const plan = pickPruneWorkspacePlan({
    check: 'unpushed',
    directory: '/w/bakery',
    result: { kind: 'checked', path: '/w/bakery', findings: [] },
    listed: [{ id: toSessionID('guest'), cwd: '/w/bakery', onMachine: false }],
    storedDirs: [{ id: toSessionID('elsewhere'), physical: '/w/pantry' }],
    remove: true,
  });

  expect(plan).toStrictEqual({ action: 'remove', path: '/w/bakery', found: [] });
});

test('it keeps a workspace with unpushed work, with what the check found', () => {
  const plan = pickPruneWorkspacePlan({
    check: 'unpushed',
    directory: '/w/bakery',
    result: { kind: 'checked', path: '/w/bakery', findings: ['1 stash'] },
    listed: [],
    storedDirs: [],
    remove: false,
  });

  expect(plan).toStrictEqual({ action: 'keep', path: '/w/bakery', reasons: ['1 stash'] });
});

test('it skips a workspace that is already gone', () => {
  const plan = pickPruneWorkspacePlan({
    check: 'unpushed',
    directory: '/w/bakery',
    result: { kind: 'missing' },
    listed: [],
    storedDirs: [{ id: toSessionID('stored'), physical: null }],
    remove: true,
  });

  expect(plan).toStrictEqual({ action: 'skip' });
});
