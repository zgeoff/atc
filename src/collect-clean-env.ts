/**
 * The process environment with any enclosing Claude or Grok session
 * scrubbed out. A child that inherits those variables behaves as part of
 * the parent session — Claude transcripts nest, and Grok joins the
 * parent's in-process dashboard — which breaks resume and isolation.
 */
export function collectCleanEnv(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || isParentSessionKey(key)) {
      continue;
    }

    env[key] = value;
  }

  return { ...env, ...extra };
}

const GROK_PARENT_KEYS = new Set([
  'GROK_SESSION_ID',
  'GROK_LEADER_SOCKET',
  'GROK_LEADER_LOG',
  'GROK_HOOK_EVENT',
  'GROK_HOOK_NAME',
  'GROK_WORKSPACE_ROOT',
  'GROK_EVENT',
  'GROK_MESSAGE',
  'GROK_PLUGIN_ROOT',
  'GROK_PLUGIN_DATA',
  'GROK_SESSION_RESTORED',
  'GROK_AGENT_METADATA',
  'GROK_INIT_STATE_MARKER__',
  'GROK_BASH_STATE_START__',
  'GROK_BASH_STATE_END__',
  'GROK_ZSH_STATE_START__',
  'GROK_ZSH_STATE_END__',
  'GROK_INSIDE_BWRAP',
]);

function isParentSessionKey(key: string): boolean {
  return (
    key === 'CLAUDECODE' ||
    key.startsWith('CLAUDE_CODE_') ||
    key.startsWith('CODEX_SANDBOX') ||
    GROK_PARENT_KEYS.has(key)
  );
}
