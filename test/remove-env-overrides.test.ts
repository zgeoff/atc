import { expect, test } from 'bun:test';
import { removeEnvOverrides } from './remove-env-overrides';
import { updateEnv } from './update-env';

test('it puts a variable the test home sets back to its test home value', () => {
  const original = process.env['GROK_HOME'];

  updateEnv('GROK_HOME', '/first/override');
  updateEnv('GROK_HOME', '/second/override');
  removeEnvOverrides();

  expect(process.env['GROK_HOME']).toBe(original);
});

test('it puts back a variable that was unset by an override', () => {
  const original = process.env['CODEX_HOME'];

  updateEnv('CODEX_HOME', undefined);
  removeEnvOverrides();

  expect(process.env['CODEX_HOME']).toBe(original);
});

test('it unsets a variable that was unset before its override', () => {
  updateEnv('ATC_TEST_REMOVE_ENV_OVERRIDES_UNSET', 'overridden');
  removeEnvOverrides();

  expect(process.env).not.toContainKey('ATC_TEST_REMOVE_ENV_OVERRIDES_UNSET');
});
