import type { ClaudeStyleHook } from '@atc/plugin-api';

// the hook file and the hook mapper both read this list, so every registered event has a meaning
export const CODEX_HOOKS = {
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  PermissionRequest: 'NeedsInput',
  Stop: 'Stop',
  SessionEnd: 'SessionEnd',
} as const satisfies Readonly<Record<string, ClaudeStyleHook>>;
