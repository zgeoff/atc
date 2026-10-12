import { expect, test } from 'bun:test';
import { updateEnv } from '../test-utils/update-env';
import { resolveAgentHome } from './resolve-agent-home';

test('it returns the env var when set and non-empty', () => {
  updateEnv('ATC_TEST_AGENT_HOME', '/custom/agent/home');

  expect(resolveAgentHome('ATC_TEST_AGENT_HOME', '.agent', '/home/me')).toBe('/custom/agent/home');
});

test('it falls back to the default directory under the home when the env var is empty', () => {
  updateEnv('ATC_TEST_AGENT_HOME', '');

  expect(resolveAgentHome('ATC_TEST_AGENT_HOME', '.agent', '/home/me')).toBe('/home/me/.agent');
});

test('it falls back to the default directory under the home when the env var is unset', () => {
  updateEnv('ATC_TEST_AGENT_HOME', undefined);

  expect(resolveAgentHome('ATC_TEST_AGENT_HOME', '.agent', '/home/me')).toBe('/home/me/.agent');
});
