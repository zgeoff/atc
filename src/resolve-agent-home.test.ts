import { expect, onTestFinished, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveAgentHome } from './resolve-agent-home';

test('it returns the env var when set and non-empty', () => {
  const prior = process.env['ATC_TEST_AGENT_HOME'];

  onTestFinished(() => {
    if (prior === undefined) {
      delete process.env['ATC_TEST_AGENT_HOME'];
    } else {
      process.env['ATC_TEST_AGENT_HOME'] = prior;
    }
  });

  process.env['ATC_TEST_AGENT_HOME'] = '/custom/agent/home';

  expect(resolveAgentHome('ATC_TEST_AGENT_HOME', '.agent')).toBe('/custom/agent/home');
});

test('it falls back to the default directory when the env var is empty', () => {
  const prior = process.env['ATC_TEST_AGENT_HOME'];

  onTestFinished(() => {
    if (prior === undefined) {
      delete process.env['ATC_TEST_AGENT_HOME'];
    } else {
      process.env['ATC_TEST_AGENT_HOME'] = prior;
    }
  });

  process.env['ATC_TEST_AGENT_HOME'] = '';

  expect(resolveAgentHome('ATC_TEST_AGENT_HOME', '.agent')).toBe(join(homedir(), '.agent'));
});

test('it falls back to the default directory when the env var is unset', () => {
  const prior = process.env['ATC_TEST_AGENT_HOME'];

  onTestFinished(() => {
    if (prior === undefined) {
      delete process.env['ATC_TEST_AGENT_HOME'];
    } else {
      process.env['ATC_TEST_AGENT_HOME'] = prior;
    }
  });

  delete process.env['ATC_TEST_AGENT_HOME'];
  expect(resolveAgentHome('ATC_TEST_AGENT_HOME', '.agent')).toBe(join(homedir(), '.agent'));
});
