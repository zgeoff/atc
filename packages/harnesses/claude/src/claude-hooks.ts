import type { ClaudeStyleHook } from '@atc/plugin-api';

// SessionStart carries the session id at spawn and resume; without it a session enters the
// fleet only at its first prompt or notification
export const CLAUDE_HOOKS = {
  SessionStart: 'SessionStart',
  Notification: 'NeedsInput',
  Stop: 'Stop',
  UserPromptSubmit: 'UserPromptSubmit',
  SessionEnd: 'SessionEnd',
} as const satisfies Readonly<Record<string, ClaudeStyleHook>>;
