import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir, updateEnv } from '@atc/test-utils';
import { loadClaudeStatusLine } from './load-claude-statusline';

// A home folder for the Claude settings a test writes.
function setupTest() {
  const tmp = setupTempDir('atc-claude-statusline-');

  return { home: tmp.path };
}

test("it reads the statusline from the home's Claude config folder", () => {
  const ctx = setupTest();

  updateEnv('CLAUDE_CONFIG_DIR', undefined);
  mkdirSync(join(ctx.home, '.claude'));
  writeFileSync(join(ctx.home, '.claude', 'settings.json'), '{"statusLine":{"padding":2}}');

  expect(loadClaudeStatusLine(ctx.home)).toStrictEqual({ padding: 2 });
});

test('it reads the statusline from the config folder CLAUDE_CONFIG_DIR sets', () => {
  const ctx = setupTest();
  const configDir = join(ctx.home, 'claude-config');

  mkdirSync(configDir);
  writeFileSync(join(configDir, 'settings.json'), '{"statusLine":{"command":"ccline"}}');
  updateEnv('CLAUDE_CONFIG_DIR', configDir);

  expect(loadClaudeStatusLine(ctx.home)).toStrictEqual({ command: 'ccline' });
});

test('it reads a missing settings file as no statusline', () => {
  const ctx = setupTest();

  updateEnv('CLAUDE_CONFIG_DIR', undefined);

  expect(loadClaudeStatusLine(ctx.home)).toStrictEqual({});
});
