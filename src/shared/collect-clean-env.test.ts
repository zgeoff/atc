import { expect, onTestFinished, test } from 'bun:test';
import { collectCleanEnv } from './collect-clean-env';

test('it strips parent-session grok keys and keeps home and api keys', () => {
  const prevSession = process.env['GROK_SESSION_ID'];
  const prevLeader = process.env['GROK_LEADER_SOCKET'];
  const prevHome = process.env['GROK_HOME'];
  const prevKey = process.env['XAI_API_KEY'];

  process.env['GROK_SESSION_ID'] = 'parent-session';
  process.env['GROK_LEADER_SOCKET'] = '/tmp/leader.sock';
  process.env['GROK_HOME'] = '/tmp/grok-home';
  process.env['XAI_API_KEY'] = 'xai-test-key';

  onTestFinished(() => {
    restoreEnv('GROK_SESSION_ID', prevSession);
    restoreEnv('GROK_LEADER_SOCKET', prevLeader);
    restoreEnv('GROK_HOME', prevHome);
    restoreEnv('XAI_API_KEY', prevKey);
  });

  const env = collectCleanEnv();

  expect(env['GROK_SESSION_ID']).toBeUndefined();
  expect(env['GROK_LEADER_SOCKET']).toBeUndefined();
  expect(env['GROK_HOME']).toBe('/tmp/grok-home');
  expect(env['XAI_API_KEY']).toBe('xai-test-key');
});

function restoreEnv(key: string, prior: string | undefined): void {
  if (prior === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = prior;
  }
}
