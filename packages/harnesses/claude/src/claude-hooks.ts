import type { ClaudeStyleHook } from '@atc/plugin-api';

/**
 * The hook events every Claude session's settings file registers, each
 * with what it means for the session. The settings file and the hook
 * mapper both read this list, so a registered event always has a meaning.
 * SessionStart carries the session id at spawn and resume, before any
 * interaction; without it a session enters the fleet only at its first
 * prompt or notification.
 */
export const CLAUDE_HOOKS = {
  SessionStart: 'SessionStart',
  Notification: 'NeedsInput',
  Stop: 'Stop',
  UserPromptSubmit: 'UserPromptSubmit',
  SessionEnd: 'SessionEnd',
} as const satisfies Readonly<Record<string, ClaudeStyleHook>>;
