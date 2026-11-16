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

test('it lists a pinned row of the next daemon before the unpinned rows of the first in the flat view', () => {
  const rows = collectSessionRows(
    [
      buildMockMirrorSession({ daemon: null, id: 'near', pinned: false }),
      buildMockMirrorSession({ daemon: 'box', id: 'far', pinned: true }),
    ],
    { daemons: [null, 'box'], grouped: false, filter: null },
  );

  expect(rows.map((row) => row.id)).toStrictEqual(['far', 'near']);
});

test.each([
  { view: 'grouped', grouped: true },
  { view: 'flat', grouped: false },
])(
  'it lists a sub-session with its pinned parent on the next daemon ahead of the first daemon in the $view view',
  (testCase) => {
    const rows = collectSessionRows(
      [
        buildMockMirrorSession({ daemon: null, id: 'near', pinned: false }),
        buildMockMirrorSession({ daemon: 'box', id: 'wrangler', pinned: true }),
        buildMockMirrorSession({ daemon: 'box', id: 'worker', parent: 'wrangler', pinned: false }),
      ],
      { daemons: [null, 'box'], grouped: testCase.grouped, filter: null },
    );

    expect(rows.map((row) => row.id)).toStrictEqual(['wrangler', 'worker', 'near']);
  },
);

test('it lists a filtered pinned row of the next daemon ahead of the filtered rows of the first', () => {
  const rows = collectSessionRows(
    [
      buildMockMirrorSession({
        daemon: null,
        id: 'near',
        name: 'orchard',
        cwd: '/w',
        pinned: false,
      }),
      buildMockMirrorSession({
        daemon: 'box',
        id: 'far',
        name: 'orchard-far',
        cwd: '/w',
        pinned: true,
      }),
      buildMockMirrorSession({
        daemon: 'box',
        id: 'other',
        name: 'harbor',
        cwd: '/w',
        pinned: true,
      }),
    ],
    { daemons: [null, 'box'], grouped: true, filter: 'orch' },
  );

  expect(rows.map((row) => row.id)).toStrictEqual(['far', 'near']);
});

test('it lists no row of a daemon outside the daemons it is given', () => {
  const rows = collectSessionRows([buildMockMirrorSession({ daemon: 'lab', id: 'x' })], {
    daemons: [null, 'box'],
    grouped: false,
    filter: null,
  });

  expect(rows).toStrictEqual([]);
});
