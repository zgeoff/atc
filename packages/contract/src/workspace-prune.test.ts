import { expect, test } from 'bun:test';
import { WORKSPACE_PRUNE_SCHEMA } from './workspace-prune';
import type { WorkspacePrune } from './workspace-prune';

test('it accepts a dry run with a folder of each verdict', () => {
  const prune: WorkspacePrune = {
    dryRun: true,
    folders: [
      { verdict: 'remove', kind: 'workspace', path: '/w/bakery-4', bytes: 4096, found: [] },
      { verdict: 'keep', kind: 'state', path: '/s/sessions/a', bytes: null, reasons: ['in use'] },
      { verdict: 'skip', kind: 'workspace', path: '/w/notes', reason: 'no atc record' },
    ],
  };

  expect(WORKSPACE_PRUNE_SCHEMA.safeParse(prune).data).toStrictEqual(prune);
});

test('it rejects a skipped state folder', () => {
  const result = WORKSPACE_PRUNE_SCHEMA.safeParse({
    dryRun: true,
    folders: [{ verdict: 'skip', kind: 'state', path: '/s/sessions/a', reason: 'no atc record' }],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['folders', 0, 'kind'] });
});

test('it rejects a folder whose size is not a whole number of bytes', () => {
  const result = WORKSPACE_PRUNE_SCHEMA.safeParse({
    dryRun: false,
    folders: [{ verdict: 'remove', kind: 'workspace', path: '/w/bakery-4', bytes: -1, found: [] }],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['folders', 0, 'bytes'] });
});
