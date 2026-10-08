import { expect, test } from 'bun:test';
import { collectRestartEnv } from './collect-restart-env';

test('it drops the session, record, and socket variables and the entries without a value', () => {
  const env = collectRestartEnv({
    HOME: '/home/u',
    ATC_SESSION_ID: 's-1',
    ATC_SOCKET: '/run/atc.sock',
    ATC_SESSION_RECORD: '/state/records/s-1.json',
    ATC_RESTORE_BOOT_TIMEOUT_MS: '500',
    GONE: undefined,
  });

  expect(env).toStrictEqual({ HOME: '/home/u', ATC_RESTORE_BOOT_TIMEOUT_MS: '500' });
});
