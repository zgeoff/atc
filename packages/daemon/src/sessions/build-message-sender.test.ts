import { expect, test } from 'bun:test';
import { toSessionID } from '@atcx/contract';
import { buildMessageSender } from './build-message-sender';

test('it labels a connector with its client id and name', () => {
  expect(
    buildMessageSender({ kind: 'connector', client: 'client-7', name: 'Lantern Notes' }, [
      { id: toSessionID('s1'), name: 'harbor-refactor' },
    ]),
  ).toStrictEqual({ kind: 'connector', client: 'client-7', name: 'Lantern Notes' });
});

test('it labels a session with its id and the name it holds now', () => {
  expect(
    buildMessageSender({ kind: 'session', session: toSessionID('s2') }, [
      { id: toSessionID('s1'), name: 'harbor-refactor' },
      { id: toSessionID('s2'), name: 'lighthouse-docs' },
    ]),
  ).toStrictEqual({ kind: 'session', session: 's2', name: 'lighthouse-docs' });
});

test('it names a session the daemon no longer holds by its id', () => {
  expect(
    buildMessageSender({ kind: 'session', session: toSessionID('s9') }, [
      { id: toSessionID('s1'), name: 'harbor-refactor' },
    ]),
  ).toStrictEqual({ kind: 'session', session: 's9', name: 's9' });
});

test('it labels the owner as the owner', () => {
  expect(
    buildMessageSender({ kind: 'owner' }, [{ id: toSessionID('s1'), name: 'harbor-refactor' }]),
  ).toStrictEqual({ kind: 'owner', name: 'owner' });
});

test('it labels a local program by the name it gives', () => {
  expect(
    buildMessageSender({ kind: 'local', name: 'lane-watch' }, [
      { id: toSessionID('s1'), name: 'harbor-refactor' },
    ]),
  ).toStrictEqual({ kind: 'local', name: 'lane-watch' });
});
