import { expect, test } from 'bun:test';
import { buildMockMirrorSession } from '../test-utils/build-mock-mirror-session';
import { buildKeyBar } from './build-key-bar';

test.each([
  {
    title: 'every key for a live session',
    session: { alive: true },
    width: 200,
    expected: '⏎ attach | / filter | f jump | p pin | K kill | X end | n new | i home | ? keys',
  },
  {
    title: 'X end in place of K kill for a dead session',
    session: { alive: false, resumable: false },
    width: 200,
    expected: '/ filter | f jump | p pin | X end | n new | i home | ? keys',
  },
  {
    title: 'a revive key for a dead session that resumes',
    session: { alive: false, resumable: true },
    width: 200,
    expected: 'P revive | / filter | f jump | p pin | X end | n new | i home | ? keys',
  },
  {
    title: 'a reattach key for a live headless session',
    session: { alive: true, kind: 'headless' },
    width: 200,
    expected: 'P reattach | / filter | f jump | p pin | K kill | X end | n new | i home | ? keys',
  },
  {
    title: 'the keys that fit, dropped from the right',
    session: { alive: true },
    width: 40,
    expected: '⏎ attach | / filter | f jump | p pin',
  },
] as const)('#buildKeyBar gives $title', (row) => {
  const session = buildMockMirrorSession(row.session);

  expect(
    buildKeyBar(session, row.width)
      .map((item) => `${item.key} ${item.label}`)
      .join(' | '),
  ).toBe(row.expected);
});

test('#buildKeyBar gives only new and keys with no row selected', () => {
  expect(
    buildKeyBar(undefined, 80)
      .map((item) => `${item.key} ${item.label}`)
      .join(' | '),
  ).toBe('n new | ? keys');
});
