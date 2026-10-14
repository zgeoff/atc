import { expect, test } from 'bun:test';
import { parseRestoreBootTimeoutMs } from './parse-restore-boot-timeout-ms';

test.each([
  ['an unset override', 15_000, undefined],
  ['an empty override', 15_000, ''],
  ['an override of 500', 500, '500'],
  ['an override of 0', 15_000, '0'],
  ['a negative override', 15_000, '-1'],
  ['an override that is not a number', 15_000, 'soon'],
])('it reads %s as %i milliseconds', (_label, expected, value) => {
  expect(parseRestoreBootTimeoutMs({ ATC_RESTORE_BOOT_TIMEOUT_MS: value })).toBe(expected);
});
