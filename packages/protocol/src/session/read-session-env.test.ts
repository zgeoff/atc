import { expect, test } from 'bun:test';
import { readSessionEnv } from './read-session-env';

test('it reads every variable the session sets', () => {
  expect(
    readSessionEnv({
      ATC_SESSION_ID: 's-1',
      ATC_SOCKET: '/run/atc.sock',
      ATC_BRIDGE: '1',
      ATC_OUTBOX: '/run/outbox',
      ATC_SESSION_RECORD: '/run/record.json',
      HOME: '/home/a',
    }),
  ).toStrictEqual({
    sessionID: 's-1',
    socket: '/run/atc.sock',
    bridge: true,
    outbox: '/run/outbox',
    sessionRecord: '/run/record.json',
  });
});

test('it leaves out an empty variable and a bridge flag other than 1', () => {
  expect(
    readSessionEnv({ ATC_SESSION_ID: '', ATC_SOCKET: '/run/atc.sock', ATC_BRIDGE: 'yes' }),
  ).toStrictEqual({
    socket: '/run/atc.sock',
  });
});
