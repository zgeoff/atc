import { expect, test } from 'bun:test';
import { buildMockMirrorSession } from '../test-utils/build-mock-mirror-session';
import { narrowListRows } from './narrow-list-rows';

test.each([
  {
    title: 'every row for nothing typed',
    typed: '',
    expected: ['# one 2 0', 'api', 'web'],
  },
  {
    title: 'the rows whose names hold the typed letters, ignoring case',
    typed: 'A',
    expected: ['# one 1 0', 'api'],
  },
  {
    title: 'no header above a group with no match left',
    typed: 'zz',
    expected: [],
  },
])('#narrowListRows gives $title', (row) => {
  const rows = narrowListRows(
    [
      { kind: 'header', label: 'one', count: 2, needYou: 0 },
      { kind: 'session', session: buildMockMirrorSession({ name: 'api' }), via: null },
      { kind: 'session', session: buildMockMirrorSession({ name: 'web' }), via: null },
    ],
    row.typed,
  );

  const lines = rows.map((listed) =>
    listed.kind === 'header'
      ? `# ${listed.label} ${listed.count} ${listed.needYou}`
      : listed.session.name,
  );

  expect(lines).toStrictEqual([...row.expected]);
});

test('#narrowListRows counts the sessions in need again for the rows that stay', () => {
  const rows = narrowListRows(
    [
      { kind: 'header', label: 'one', count: 2, needYou: 1 },
      {
        kind: 'session',
        session: buildMockMirrorSession({ name: 'api', state: 'needs_you' }),
        via: null,
      },
      { kind: 'session', session: buildMockMirrorSession({ name: 'web' }), via: null },
    ],
    'web',
  );

  expect(rows[0]).toStrictEqual({ kind: 'header', label: 'one', count: 1, needYou: 0 });
});
