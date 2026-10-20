import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir, updateEnv } from '@atc/test-utils';
import { resolveClaudeGlobalConfigPath } from './resolve-claude-global-config-path';

// The folder that stands in for the user's home or the Claude config folder.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-claude-config-path-');

  return { directory: temporaryDirectory.path };
}

test('it resolves the config in the home directory when no config folder is set', () => {
  const ctx = setupTest();

  updateEnv('CLAUDE_CONFIG_DIR', undefined);

  expect(resolveClaudeGlobalConfigPath(ctx.directory)).toBe(join(ctx.directory, '.claude.json'));
});

test('it resolves the config in the home directory when the home config folder holds a legacy config', () => {
  const ctx = setupTest();

  updateEnv('CLAUDE_CONFIG_DIR', undefined);
  mkdirSync(join(ctx.directory, '.claude'));
  writeFileSync(join(ctx.directory, '.claude', '.config.json'), '{}');

  expect(resolveClaudeGlobalConfigPath(ctx.directory)).toBe(join(ctx.directory, '.claude.json'));
});

test('it resolves the config inside the config folder the environment sets', () => {
  const ctx = setupTest();

  updateEnv('CLAUDE_CONFIG_DIR', join(ctx.directory, 'config'));

  expect(resolveClaudeGlobalConfigPath(join(ctx.directory, 'home'))).toBe(
    join(ctx.directory, 'config', '.claude.json'),
  );
});

test('it resolves the config inside the config folder the environment sets when that folder holds a legacy config', () => {
  const ctx = setupTest();

  updateEnv('CLAUDE_CONFIG_DIR', ctx.directory);
  writeFileSync(join(ctx.directory, '.config.json'), '{}');

  expect(resolveClaudeGlobalConfigPath(join(ctx.directory, 'home'))).toBe(
    join(ctx.directory, '.claude.json'),
  );
});
