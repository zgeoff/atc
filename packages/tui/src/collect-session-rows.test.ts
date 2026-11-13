import { expect, test } from 'bun:test';
import { collectSessionRows } from './collect-session-rows';
import { buildMockMirrorSession } from './testing/build-mock-mirror-session';

test('it lists the rows of the first daemon before the rows of the next', () => {
  const rows = collectSessionRows(
    [
      buildMockMirrorSession({ daemon: 'box', id: 'far', lastAttachedAt: 9 }),
      buildMockMirrorSession({ daemon: null, id: 'near', lastAttachedAt: 1 }),
    ],
    { daemons: [null, 'box'], grouped: false, filter: null },
  );

  expect(rows.map((row) => row.id)).toStrictEqual(['near', 'far']);
});

test('it nests a sub-session under the parent on its own daemon when two daemons hold the same parent id', () => {
  const rows = collectSessionRows(
    [
      buildMockMirrorSession({ daemon: null, id: 'wrangler', createdAt: 1, lastAttachedAt: 1 }),
      buildMockMirrorSession({ daemon: 'box', id: 'wrangler', createdAt: 2, lastAttachedAt: 2 }),
      buildMockMirrorSession({
        daemon: 'box',
        id: 'worker',
        parent: 'wrangler',
        createdAt: 3,
        lastAttachedAt: 3,
      }),
    ],
    { daemons: [null, 'box'], grouped: false, filter: null },
  );

  expect(rows.map((row) => [row.daemon, row.id])).toStrictEqual([
    [null, 'wrangler'],
    ['box', 'wrangler'],
    ['box', 'worker'],
  ]);
});

test('it keeps the rows that match the filter on each daemon', () => {
  const rows = collectSessionRows(
    [
      buildMockMirrorSession({ daemon: null, id: 'a', name: 'orchard' }),
      buildMockMirrorSession({ daemon: 'box', id: 'b', name: 'orchard-far' }),
      buildMockMirrorSession({ daemon: 'box', id: 'c', name: 'harbor' }),
    ],
    { daemons: [null, 'box'], grouped: false, filter: 'orch' },
  );

  expect(rows.map((row) => row.id)).toStrictEqual(['a', 'b']);
});

test('it lists no row of a daemon outside the daemons it is given', () => {
  const rows = collectSessionRows([buildMockMirrorSession({ daemon: 'lab', id: 'x' })], {
    daemons: [null, 'box'],
    grouped: false,
    filter: null,
  });

  expect(rows).toStrictEqual([]);
});
