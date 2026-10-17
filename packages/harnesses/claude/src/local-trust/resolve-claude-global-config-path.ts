import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHomeDir } from '@atc/config/host';

// resolved as the Claude CLI resolves it
export function resolveClaudeGlobalConfigPath(homeDir: string = resolveHomeDir()): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  const custom = configDir !== undefined && configDir !== '' ? configDir : null;
  const legacy = join(custom ?? join(homeDir, '.claude'), '.config.json');

  return existsSync(legacy) ? legacy : join(custom ?? homeDir, '.claude.json');
}
