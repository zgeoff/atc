import { findClaudeMenu } from './find-claude-menu';

// Claude Code runs no hook while a pre-start dialog, such as the folder-trust check, waits.
// Only the screen shows that wait.
export function pickClaudeAttention(screen: string): 'needs-input' | 'working' {
  return findClaudeMenu(screen) === null ? 'working' : 'needs-input';
}
