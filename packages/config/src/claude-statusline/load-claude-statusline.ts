import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAgentHome } from '../host/resolve-agent-home';
import type { ClaudeStatusLine } from './parse-claude-statusline';
import { parseClaudeStatusLine } from './parse-claude-statusline';

/**
 * The statusline of the person's own Claude settings: `settings.json` in
 * the Claude config folder, `$CLAUDE_CONFIG_DIR` or `.claude` in the home
 * `homeDir`. A missing or unreadable file reads as no statusline.
 */
export function loadClaudeStatusLine(homeDir?: string): ClaudeStatusLine {
  const file = join(resolveAgentHome('CLAUDE_CONFIG_DIR', '.claude', homeDir), 'settings.json');

  try {
    return parseClaudeStatusLine(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
