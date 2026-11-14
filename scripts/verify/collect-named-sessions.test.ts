import { expect, test } from 'bun:test';
import { collectNamedSessions } from './collect-named-sessions.ts';

test('it keeps only the sessions with the name, live or exited', () => {
  const sessions = [
    { id: 'id-1', name: 'wv-plum', alive: true },
    { id: 'id-2', name: 'wv-fig', alive: true },
    { id: 'id-3', name: 'wv-plum', alive: false },
  ];

  expect(collectNamedSessions(sessions, 'wv-plum')).toStrictEqual([
    { id: 'id-1', alive: true },
    { id: 'id-3', alive: false },
  ]);
});

test('it returns none for a name no session has', () => {
  expect(
    collectNamedSessions([{ id: 'id-1', name: 'wv-fig', alive: true }], 'wv-plum'),
  ).toStrictEqual([]);
});
