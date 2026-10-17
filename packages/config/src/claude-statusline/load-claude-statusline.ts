import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAgentHome } from '../host/resolve-agent-home';
import type { ClaudeStatusLine } from './parse-claude-statusline';
import { parseClaudeStatusLine } from './parse-claude-statusline';

export function loadClaudeStatusLine(homeDir?: string): ClaudeStatusLine {
  const file = join(resolveAgentHome('CLAUDE_CONFIG_DIR', '.claude', homeDir), 'settings.json');

  try {
    return parseClaudeStatusLine(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
