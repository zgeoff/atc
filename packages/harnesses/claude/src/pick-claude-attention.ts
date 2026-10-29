import { findClaudeMenu } from './find-claude-menu';

// Claude Code runs no hook while a dialog it shows before its start waits,
// such as the folder-trust check, so the screen alone shows that wait.
export function pickClaudeAttention(screen: string): 'needs-input' | 'working' {
  return findClaudeMenu(screen) === null ? 'working' : 'needs-input';
}
