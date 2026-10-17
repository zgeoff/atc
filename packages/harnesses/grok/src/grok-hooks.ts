// the hook file and the hook mapper both read this list, so every registered event has a meaning
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
