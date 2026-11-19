import type { ClaudeStyleHook } from '@atc/plugin-api';

export const CODEX_HOOKS = {
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  PermissionRequest: 'NeedsInput',
  Stop: 'Stop',
  SessionEnd: 'SessionEnd',
} as const satisfies Readonly<Record<string, ClaudeStyleHook>>;
