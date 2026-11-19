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
