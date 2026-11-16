import { expect, test } from 'bun:test';
import { collectPinnedFirst } from './collect-pinned-first';

test('it lists the pinned rows of every fleet before the unpinned rows of any', () => {
  const rows = collectPinnedFirst([
    [
      { id: 'north', parent: null, pinned: true },
      { id: 'south', parent: null, pinned: false },
    ],
    [
      { id: 'east', parent: null, pinned: true },
      { id: 'west', parent: null, pinned: false },
    ],
  ]);

  expect(rows.map((row) => row.id)).toStrictEqual(['north', 'east', 'south', 'west']);
});

test('it lists a sub-session with its parent by the parent pin, not its own', () => {
  const rows = collectPinnedFirst([
    [{ id: 'south', parent: null, pinned: false }],
    [
      { id: 'wrangler', parent: null, pinned: true },
      { id: 'worker', parent: 'wrangler', pinned: false },
      { id: 'lead', parent: null, pinned: false },
      { id: 'helper', parent: 'lead', pinned: true },
    ],
  ]);

  expect(rows.map((row) => row.id)).toStrictEqual([
    'wrangler',
    'worker',
    'south',
    'lead',
    'helper',
  ]);
});

test('it ignores a pinned parent id that only another fleet holds', () => {
  const rows = collectPinnedFirst<{ id: string; parent: string | null; pinned: boolean }>([
    [
      { id: 'wrangler', parent: null, pinned: true },
      { id: 'south', parent: null, pinned: false },
    ],
    [{ id: 'worker', parent: 'wrangler', pinned: false }],
  ]);

  expect(rows.map((row) => row.id)).toStrictEqual(['wrangler', 'south', 'worker']);
});
