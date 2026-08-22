import { expect, onTestFinished, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveAgentHome } from './resolve-agent-home';

const VAR = 'ATC_TEST_AGENT_HOME';

// Sets the variable under test for one test and puts back whatever the
// environment held, including its absence.
function setupEnv(value: string | undefined) {
  const prior = process.env[VAR];

  onTestFinished(() => {
    if (prior === undefined) {
      delete process.env[VAR];
    } else {
      process.env[VAR] = prior;
    }
  });

  if (value === undefined) {
    delete process.env[VAR];
  } else {
    process.env[VAR] = value;
  }
}

test('it returns the env var when set and non-empty', () => {
  setupEnv('/custom/agent/home');

  expect(resolveAgentHome(VAR, '.agent')).toBe('/custom/agent/home');
});

test('it falls back to the default directory when the env var is empty', () => {
  setupEnv('');

  expect(resolveAgentHome(VAR, '.agent')).toBe(join(homedir(), '.agent'));
});

test('it falls back to the default directory when the env var is unset', () => {
  setupEnv(undefined);

  expect(resolveAgentHome(VAR, '.agent')).toBe(join(homedir(), '.agent'));
});
