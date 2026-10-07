import { expect, test } from 'bun:test';
import { updateEnv } from '../test-utils/update-env';
import { collectCleanEnv } from './collect-clean-env';

test('it strips parent-session grok keys and keeps home and api keys', () => {
  updateEnv('GROK_SESSION_ID', 'parent-session');
  updateEnv('GROK_LEADER_SOCKET', '/tmp/leader.sock');
  updateEnv('GROK_HOME', '/tmp/grok-home');
  updateEnv('XAI_API_KEY', 'xai-test-key');

  const env = collectCleanEnv();

  expect(env).not.toContainAnyKeys(['GROK_SESSION_ID', 'GROK_LEADER_SOCKET']);

  expect(env).toContainEntries([
    ['GROK_HOME', '/tmp/grok-home'],
    ['XAI_API_KEY', 'xai-test-key'],
  ]);
});

test('it leaves withheld variables out and keeps an explicit extra of the same name', () => {
  updateEnv('ATC_TEST_WITHHELD', 'fixture-not-a-secret');
  updateEnv('ATC_TEST_EXPLICIT', 'inherited');

  const env = collectCleanEnv({ ATC_TEST_EXPLICIT: 'configured' }, [
    'ATC_TEST_WITHHELD',
    'ATC_TEST_EXPLICIT',
  ]);

  expect(env).not.toContainKey('ATC_TEST_WITHHELD');
  expect(env).toContainEntry(['ATC_TEST_EXPLICIT', 'configured']);
});
