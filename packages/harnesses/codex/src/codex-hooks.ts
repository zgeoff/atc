import type { ClaudeStyleHook } from '@atc/plugin-api/harness/build-claude-style-hook-event';

/**
 * The hook events the Codex hook file registers, each with what it means
 * for the session. The hook file and the hook mapper both read this list,
 * so a registered event always has a meaning. Codex asks for a person's
 * approval through a permission request.
 */
export const CODEX_HOOKS = {
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  PermissionRequest: 'NeedsInput',
  Stop: 'Stop',
  SessionEnd: 'SessionEnd',
} as const satisfies Readonly<Record<string, ClaudeStyleHook>>;
