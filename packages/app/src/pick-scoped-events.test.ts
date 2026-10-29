import { expect, test } from 'bun:test';
import { pickScopedEvents } from './pick-scoped-events';

test('it forwards the events of a readable session in order', () => {
  expect(
    pickScopedEvents(
      [
        { ev: 'SessionOutput', sessionID: 'on-local', seq: 1, data: 'one' },
        { ev: 'SessionResized', sessionID: 'on-local', cols: 100, rows: 30 },
      ],
      new Map([['on-local', { kind: 'readable' }]]),
      new Set(),
    ),
  ).toStrictEqual({
    forward: [
      { ev: 'SessionOutput', sessionID: 'on-local', seq: 1, data: 'one' },
      { ev: 'SessionResized', sessionID: 'on-local', cols: 100, rows: 30 },
    ],
    removed: [],
    failure: null,
  });
});

test('it replaces the events of an unreadable session with one removal', () => {
  expect(
    pickScopedEvents(
      [
        { ev: 'SessionOutput', sessionID: 'on-local', seq: 1, data: 'one' },
        { ev: 'SessionOutput', sessionID: 'on-spare', seq: 1, data: 'two' },
        { ev: 'SessionOutput', sessionID: 'on-spare', seq: 2, data: 'three' },
      ],
      new Map([
        ['on-local', { kind: 'readable' }],
        ['on-spare', { kind: 'unreadable' }],
      ]),
      new Set(),
    ),
  ).toStrictEqual({
    forward: [
      { ev: 'SessionOutput', sessionID: 'on-local', seq: 1, data: 'one' },
      { ev: 'SessionRemoved', sessionID: 'on-spare' },
    ],
    removed: ['on-spare'],
    failure: null,
  });
});

test('it drops the events of a session an earlier batch removed', () => {
  expect(
    pickScopedEvents(
      [{ ev: 'SessionOutput', sessionID: 'on-spare', seq: 3, data: 'four' }],
      new Map(),
      new Set(['on-spare']),
    ),
  ).toStrictEqual({ forward: [], removed: [], failure: null });
});

test('it drops an event that belongs to no session', () => {
  expect(
    pickScopedEvents(
      [{ ev: 'PermissionResolved', request: 'request-1', decision: 'allow' }],
      new Map(),
      new Set(),
    ),
  ).toStrictEqual({ forward: [], removed: [], failure: null });
});

test('it stops the batch at the first session whose read failed', () => {
  const error = new Error('the outbound queue is full');

  expect(
    pickScopedEvents(
      [
        { ev: 'SessionOutput', sessionID: 'on-local', seq: 1, data: 'one' },
        { ev: 'SessionOutput', sessionID: 'on-other', seq: 1, data: 'two' },
        { ev: 'SessionOutput', sessionID: 'on-local', seq: 2, data: 'three' },
      ],
      new Map([
        ['on-local', { kind: 'readable' }],
        ['on-other', { kind: 'failed', error }],
      ]),
      new Set(),
    ),
  ).toStrictEqual({
    forward: [{ ev: 'SessionOutput', sessionID: 'on-local', seq: 1, data: 'one' }],
    removed: [],
    failure: { sessionID: 'on-other', error },
  });
});
