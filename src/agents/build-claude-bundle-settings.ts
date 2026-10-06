import { isRecord } from '../shared/report';

/**
 * The user settings a session's own Claude config folder starts with, from
 * the host's own `settings.json`: the keys on the allow-list alone, an
 * `env` block cut to its own allow-list, and a permission default of auto
 * mode, which Claude Code honours at user scope only. Any other key stays on
 * the host, so a setting that holds a credential, a plugin, or a host path
 * never reaches a guest unless it is listed here. The statusline command
 * reads the guest's copy of a script under the host's config folder:
 * a path under `hostDir` in the command moves under `guestDir`.
 */
export function buildClaudeBundleSettings(
  settings: unknown,
  hostDir: string,
  guestDir: string,
): Record<string, unknown> {
  const source = isRecord(settings) ? settings : {};
  const shipped: Record<string, unknown> = {};

  for (const key of SETTINGS_ALLOW_LIST) {
    if (source[key] !== undefined) {
      shipped[key] = source[key];
    }
  }

  const env = buildBundleEnv(source['env']);
  const statusLine = buildBundleStatusLine(source['statusLine'], hostDir, guestDir);

  return {
    ...shipped,
    ...(env === null ? {} : { env }),
    ...(statusLine === null ? {} : { statusLine }),
    permissions: {
      ...(isRecord(source['permissions']) ? source['permissions'] : {}),
      defaultMode: 'auto',
    },
  };
}

const SETTINGS_ALLOW_LIST = [
  'model',
  'effortLevel',
  'advisorModel',
  'outputStyle',
  'autoCompactWindow',
  'autoMode',
  'attribution',
  'includeCoAuthoredBy',
  'skipAutoPermissionPrompt',
  'skipWorkflowUsageWarning',
  'editorMode',
  'tui',
] as const;

// The variables an `env` block may ship. A variable off this list may hold
// a credential, so it stays on the host.
const ENV_ALLOW_LIST: ReadonlySet<string> = new Set(['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS']);

function buildBundleEnv(env: unknown): Record<string, string> | null {
  if (!isRecord(env)) {
    return null;
  }

  const shipped = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        ENV_ALLOW_LIST.has(entry[0]) && typeof entry[1] === 'string',
    ),
  );

  return Object.keys(shipped).length === 0 ? null : shipped;
}

function buildBundleStatusLine(
  statusLine: unknown,
  hostDir: string,
  guestDir: string,
): Record<string, unknown> | null {
  if (!isRecord(statusLine) || typeof statusLine['command'] !== 'string') {
    return null;
  }

  return {
    ...statusLine,
    command: statusLine['command'].replaceAll(`${hostDir}/`, `${guestDir}/`),
  };
}
