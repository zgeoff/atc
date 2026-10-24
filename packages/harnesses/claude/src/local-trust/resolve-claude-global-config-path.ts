import { join } from 'node:path';
import { resolveHomeDir } from '@atcx/contract/light';

// A config left at Claude's older `.config.json` location is never read.
export function resolveClaudeGlobalConfigPath(homeDir: string = resolveHomeDir()): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  const directory = configDir !== undefined && configDir !== '' ? configDir : homeDir;

  return join(directory, '.claude.json');
}
