import { expect, test } from 'bun:test';
import { buildSessionEnv } from './build-session-env';

test('it writes every set field under its variable', () => {
  expect(
    buildSessionEnv({
      sessionID: 's-1',
      socket: '/run/atc.sock',
      bridge: true,
      outbox: '/run/outbox',
      sessionRecord: '/run/record.json',
    }),
  ).toStrictEqual({
    ATC_SESSION_ID: 's-1',
    ATC_SOCKET: '/run/atc.sock',
    ATC_BRIDGE: '1',
    ATC_OUTBOX: '/run/outbox',
    ATC_SESSION_RECORD: '/run/record.json',
    AUTO_MODE_SCOPE_FILE: '/run/record.scope.json',
  });
});

test('it leaves out a field that is not set and a bridge that is off', () => {
  expect(buildSessionEnv({ sessionID: 's-1', bridge: false })).toStrictEqual({
    ATC_SESSION_ID: 's-1',
  });
});
