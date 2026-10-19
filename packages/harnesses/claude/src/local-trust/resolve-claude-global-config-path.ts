import { join } from 'node:path';
import { resolveHomeDir } from '@atc/config/host';

// A config left at Claude's older `.config.json` location is never read.
export function resolveClaudeGlobalConfigPath(homeDir: string = resolveHomeDir()): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  const dir = configDir !== undefined && configDir !== '' ? configDir : homeDir;

  return join(dir, '.claude.json');
}
