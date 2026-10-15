import { expect, test } from 'bun:test';
import { toSessionID } from '@atc/core';
import { buildMessageSender } from './build-message-sender';

const SESSIONS = [
  { id: toSessionID('s1'), name: 'harbor-refactor' },
  { id: toSessionID('s2'), name: 'lighthouse-docs' },
];

test('it labels a connector with its client id and name', () => {
  expect(
    buildMessageSender({ kind: 'connector', client: 'client-7', name: 'Lantern Notes' }, SESSIONS),
  ).toStrictEqual({ kind: 'connector', client: 'client-7', name: 'Lantern Notes' });
});

test('it labels a session with its id and the name it holds now', () => {
  expect(
    buildMessageSender({ kind: 'session', session: toSessionID('s2') }, SESSIONS),
  ).toStrictEqual({ kind: 'session', session: 's2', name: 'lighthouse-docs' });
});

test('it names a session the daemon no longer holds by its id', () => {
  expect(
    buildMessageSender({ kind: 'session', session: toSessionID('s9') }, SESSIONS),
  ).toStrictEqual({ kind: 'session', session: 's9', name: 's9' });
});

test('it labels the owner as the owner', () => {
  expect(buildMessageSender({ kind: 'owner' }, SESSIONS)).toStrictEqual({
    kind: 'owner',
    name: 'owner',
  });
});

test('it labels a local program by the name it gives', () => {
  expect(buildMessageSender({ kind: 'local', name: 'lane-watch' }, SESSIONS)).toStrictEqual({
    kind: 'local',
    name: 'lane-watch',
  });
});
