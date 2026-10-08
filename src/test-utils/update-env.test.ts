import { expect, test } from 'bun:test';
import { updateEnv } from './update-env';

test('it sets a variable to the override value', () => {
  updateEnv('ATC_TEST_UPDATE_ENV_SET', 'overridden');

  expect(process.env['ATC_TEST_UPDATE_ENV_SET']).toBe('overridden');
});

test('it unsets a variable when the override value is undefined', () => {
  updateEnv('ATC_TEST_UPDATE_ENV_UNSET', 'present');
  updateEnv('ATC_TEST_UPDATE_ENV_UNSET', undefined);

  expect(process.env).not.toContainKey('ATC_TEST_UPDATE_ENV_UNSET');
});
