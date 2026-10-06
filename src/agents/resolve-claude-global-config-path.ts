import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHomeDir } from '../shared/resolve-home-dir';

/**
 * The file the Claude CLI on the daemon's machine keeps its global state
 * in, folder trust included, resolved as the CLI resolves it: a legacy
 * `.config.json` in its config folder when one exists, otherwise
 * `.claude.json` in `$CLAUDE_CONFIG_DIR`, or in the user's home when that
 * is unset or empty.
 */
export function resolveClaudeGlobalConfigPath(): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  const custom = configDir !== undefined && configDir !== '' ? configDir : null;
  const legacy = join(custom ?? join(resolveHomeDir(), '.claude'), '.config.json');

  return existsSync(legacy) ? legacy : join(custom ?? resolveHomeDir(), '.claude.json');
}
