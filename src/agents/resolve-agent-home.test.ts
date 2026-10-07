import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { updateEnv } from '../test-utils/update-env';
import { resolveAgentHome } from './resolve-agent-home';

const VAR = 'ATC_TEST_AGENT_HOME';

test('it returns the env var when set and non-empty', () => {
  updateEnv(VAR, '/custom/agent/home');

  expect(resolveAgentHome(VAR, '.agent')).toBe('/custom/agent/home');
});

test('it falls back to the default directory under the home when the env var is empty', () => {
  updateEnv(VAR, '');

  const root = process.env['ATC_TEST_HOME'];

  if (root === undefined) {
    throw new Error('the test home fixture is not in place');
  }

  expect(resolveAgentHome(VAR, '.agent')).toBe(join(root, 'home', '.agent'));
});

test('it falls back to the default directory under the home when the env var is unset', () => {
  updateEnv(VAR, undefined);

  const root = process.env['ATC_TEST_HOME'];

  if (root === undefined) {
    throw new Error('the test home fixture is not in place');
  }

  expect(resolveAgentHome(VAR, '.agent')).toBe(join(root, 'home', '.agent'));
});
