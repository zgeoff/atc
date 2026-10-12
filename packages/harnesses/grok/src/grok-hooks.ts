/**
 * The hook events the Grok hook file registers. The hook file and the hook
 * mapper both read this list, so a registered event always has a meaning.
 */
export const GROK_HOOKS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'StopCancelled',
  'Notification',
] as const;

export type GrokHook = (typeof GROK_HOOKS)[number];
