import type { ClaudeStyleHook } from '@atc/plugin-api';

export const CLAUDE_HOOKS = {
  SessionStart: 'SessionStart',
  Notification: 'NeedsInput',
  Stop: 'Stop',
  StopFailure: 'TurnFailed',
  UserPromptSubmit: 'UserPromptSubmit',
  SessionEnd: 'SessionEnd',
} as const satisfies Readonly<Record<string, ClaudeStyleHook>>;
