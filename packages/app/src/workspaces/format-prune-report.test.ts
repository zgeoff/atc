import { expect, test } from 'bun:test';
import { formatPruneReport } from './format-prune-report';

test('it prints a dry run with a line per workspace, one for the state folders, and what --yes removes', () => {
  const lines = formatPruneReport({
    dryRun: true,
    folders: [
      {
        verdict: 'remove',
        kind: 'workspace',
        path: '/w/bakery-main-12',
        bytes: 412_000_000,
        found: [],
      },
      {
        verdict: 'keep',
        kind: 'workspace',
        path: '/w/pantry-main-3',
        bytes: 43_000_000,
        reasons: ['1 uncommitted or untracked path'],
      },
      { verdict: 'skip', kind: 'workspace', path: '/w/notes', reason: 'no atc record' },
      { verdict: 'remove', kind: 'state', path: '/s/sessions/a', bytes: 1_500_000, found: [] },
      { verdict: 'remove', kind: 'state', path: '/s/sessions/b', bytes: 500_000, found: [] },
    ],
  });

  expect(lines).toStrictEqual([
    'remove  bakery-main-12  412 MB  clean',
    'keep    pantry-main-3    43 MB  1 uncommitted or untracked path',
    'skip    notes                   no atc record',
    'state   2 folders       2.0 MB  no listed session',
    'run again with --yes to remove 1 workspace and 2 state folders (414 MB)',
  ]);
});

test('it prints a prune with remove with what it removed and a kept state folder', () => {
  const lines = formatPruneReport({
    dryRun: false,
    folders: [
      {
        verdict: 'remove',
        kind: 'workspace',
        path: '/w/rye-7',
        bytes: 1_100_000_000,
        found: ['2 stashes'],
      },
      {
        verdict: 'keep',
        kind: 'state',
        path: '/s/sessions/c',
        bytes: null,
        reasons: ['removing it failed: EACCES'],
      },
    ],
  });

  expect(lines).toStrictEqual([
    'removed  rye-7    1.1 GB  2 stashes',
    'keep     state c       ?  removing it failed: EACCES',
    'removed 1 workspace and 0 state folders (1.1 GB)',
  ]);
});

test('it prints that nothing is left to remove', () => {
  expect(formatPruneReport({ dryRun: true, folders: [] })).toStrictEqual(['nothing to remove']);
});
