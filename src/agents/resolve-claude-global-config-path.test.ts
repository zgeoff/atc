import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHomeDir } from '../shared/resolve-home-dir';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { updateEnv } from '../test-utils/update-env';
import { resolveClaudeGlobalConfigPath } from './resolve-claude-global-config-path';

function setupTest() {
  return setupTempDir('atc-claude-config-path-');
}

test('it resolves the config in the home directory when no config folder is set', () => {
  updateEnv('CLAUDE_CONFIG_DIR', undefined);

  expect(resolveClaudeGlobalConfigPath()).toBe(join(resolveHomeDir(), '.claude.json'));
});

test('it resolves the config inside the config folder the environment sets', () => {
  using tmp = setupTest();

  updateEnv('CLAUDE_CONFIG_DIR', tmp.dir);

  expect(resolveClaudeGlobalConfigPath()).toBe(join(tmp.dir, '.claude.json'));
});

test('it resolves the legacy config when the config folder holds one', () => {
  using tmp = setupTest();

  updateEnv('CLAUDE_CONFIG_DIR', tmp.dir);
  mkdirSync(tmp.dir, { recursive: true });
  writeFileSync(join(tmp.dir, '.config.json'), '{}');

  expect(resolveClaudeGlobalConfigPath()).toBe(join(tmp.dir, '.config.json'));
});
