import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { updateEnv } from '../test-utils/update-env';
import { resolveClaudeGlobalConfigPath } from './resolve-claude-global-config-path';

// The folder that stands in for the user's home or the Claude config folder.
function setupTest() {
  const tmp = setupTempDir('atc-claude-config-path-');

  return { dir: tmp.dir };
}

test('it resolves the config in the home directory when no config folder is set', () => {
  const ctx = setupTest();

  updateEnv('CLAUDE_CONFIG_DIR', undefined);

  expect(resolveClaudeGlobalConfigPath(ctx.dir)).toBe(join(ctx.dir, '.claude.json'));
});

test('it resolves the legacy config in the home config folder when it holds one', () => {
  const ctx = setupTest();

  updateEnv('CLAUDE_CONFIG_DIR', undefined);
  mkdirSync(join(ctx.dir, '.claude'));
  writeFileSync(join(ctx.dir, '.claude', '.config.json'), '{}');

  expect(resolveClaudeGlobalConfigPath(ctx.dir)).toBe(join(ctx.dir, '.claude', '.config.json'));
});

test('it resolves the config inside the config folder the environment sets', () => {
  const ctx = setupTest();

  updateEnv('CLAUDE_CONFIG_DIR', join(ctx.dir, 'config'));

  expect(resolveClaudeGlobalConfigPath(join(ctx.dir, 'home'))).toBe(
    join(ctx.dir, 'config', '.claude.json'),
  );
});

test('it resolves the legacy config when the config folder holds one', () => {
  const ctx = setupTest();

  updateEnv('CLAUDE_CONFIG_DIR', ctx.dir);
  writeFileSync(join(ctx.dir, '.config.json'), '{}');

  expect(resolveClaudeGlobalConfigPath(join(ctx.dir, 'home'))).toBe(join(ctx.dir, '.config.json'));
});
