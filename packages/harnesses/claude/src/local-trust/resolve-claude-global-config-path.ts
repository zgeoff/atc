import { join } from 'node:path';
import { resolveHomeDir } from '@atc/config/host';

// Claude's global config at its current location: `.claude.json` in the
// config folder the environment sets, or else in the home directory. A
// config left at Claude's older `.config.json` location is never read.
export function resolveClaudeGlobalConfigPath(homeDir: string = resolveHomeDir()): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  const dir = configDir !== undefined && configDir !== '' ? configDir : homeDir;

  return join(dir, '.claude.json');
}
