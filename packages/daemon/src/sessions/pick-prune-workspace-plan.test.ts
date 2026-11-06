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
    resolvedDirs: [],
    remove: row.remove,
  });

  expect(plan).toStrictEqual({ action: row.action, path: '/srv/w/bakery', found: [] });
});

test.each([
  {
    user: 'a session on the machine that runs inside it',
    listed: [{ id: 'plain', cwd: '/w/bakery/src', onMachine: true }],
    resolvedDirs: [],
    reason: 'in use by session plain',
  },
  {
    user: 'a session on the machine that runs inside its resolved path',
    listed: [{ id: 'plain', cwd: '/srv/w/bakery', onMachine: true }],
    resolvedDirs: [],
    reason: 'in use by session plain',
  },
  {
    user: 'a session whose directory resolves inside it',
    listed: [],
    resolvedDirs: [{ id: 'linked', physical: '/srv/w/bakery/src' }],
    reason: 'in use by session linked',
  },
  {
    user: 'a session whose directory did not resolve',
    listed: [],
    resolvedDirs: [{ id: 'linked', physical: null }],
    reason: 'in use by session linked',
  },
])('it keeps a clean workspace that $user uses', (row) => {
  const plan = pickPruneWorkspacePlan({
    check: 'none',
    directory: '/w/bakery',
    result: { kind: 'checked', path: '/srv/w/bakery', findings: [] },
    listed: row.listed.map((session) => ({ ...session, id: toSessionID(session.id) })),
    resolvedDirs: row.resolvedDirs.map((resolved) => ({
      ...resolved,
      id: toSessionID(resolved.id),
    })),
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
    resolvedDirs: [{ id: toSessionID('elsewhere'), physical: '/w/pantry' }],
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
    resolvedDirs: [],
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
    resolvedDirs: [{ id: toSessionID('stored'), physical: null }],
    remove: true,
  });

  expect(plan).toStrictEqual({ action: 'skip' });
});
