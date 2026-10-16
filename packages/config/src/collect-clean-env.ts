/**
 * The process environment with any enclosing Claude, Codex, or Grok
 * session scrubbed out. A child that inherits those variables behaves as part of
 * the parent session — Claude transcripts nest, and Grok joins the
 * parent's in-process dashboard — which breaks resume and isolation.
 *
 * Variables named in `withheld` are left out of what the child inherits,
 * such as a workspace credential that only the daemon's own git commands
 * may see. The extras the caller sets explicitly are added after, so one
 * of them is kept even when it shares a withheld name.
 */
export function collectCleanEnv(
  extra: Readonly<Record<string, string>> = {},
  withheld: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};

  const skipped = new Set(withheld);

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || isParentSessionKey(key) || skipped.has(key)) {
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

// What Codex sets on each process a tool of a Codex thread starts. The hook
// reporter reads the thread key as the mark of a harness nested in a
// session, so a session atc starts must never carry it.
const CODEX_PARENT_KEYS = new Set(['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_TOOL_CALL_ID']);

function isParentSessionKey(key: string): boolean {
  return (
    key === 'CLAUDECODE' ||
    key.startsWith('CLAUDE_CODE_') ||
    key.startsWith('CODEX_SANDBOX') ||
    CODEX_PARENT_KEYS.has(key) ||
    GROK_PARENT_KEYS.has(key)
  );
}
