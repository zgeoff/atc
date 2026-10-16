import { expect, test } from 'bun:test';
import { updateEnv } from '@atc/test-utils';
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

test('it strips the variable that marks a parent Claude Code session', () => {
  updateEnv('CLAUDECODE', '1');

  expect(collectCleanEnv()).not.toContainKey('CLAUDECODE');
});

test('it strips every variable a parent Claude Code session sets under its prefix', () => {
  updateEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
  updateEnv('CLAUDE_CODE_SSE_PORT', '4242');

  expect(collectCleanEnv()).not.toContainAnyKeys([
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SSE_PORT',
  ]);
});

test('it strips every variable a parent Codex sandbox sets under its prefix', () => {
  updateEnv('CODEX_SANDBOX', 'seatbelt');
  updateEnv('CODEX_SANDBOX_NETWORK_DISABLED', '1');

  expect(collectCleanEnv()).not.toContainAnyKeys([
    'CODEX_SANDBOX',
    'CODEX_SANDBOX_NETWORK_DISABLED',
  ]);
});

test('it strips the variables a parent Codex thread sets on its tool processes', () => {
  updateEnv('CODEX_THREAD_ID', 'codex-parent');
  updateEnv('CODEX_SESSION_ID', 'codex-parent');
  updateEnv('CODEX_TOOL_CALL_ID', 'call-1');

  expect(collectCleanEnv()).not.toContainAnyKeys([
    'CODEX_THREAD_ID',
    'CODEX_SESSION_ID',
    'CODEX_TOOL_CALL_ID',
  ]);
});

test('it keeps a Claude variable outside the parent-session prefix', () => {
  updateEnv('CLAUDE_CONFIG_DIR', '/tmp/claude-config');

  expect(collectCleanEnv()).toContainEntry(['CLAUDE_CONFIG_DIR', '/tmp/claude-config']);
});
