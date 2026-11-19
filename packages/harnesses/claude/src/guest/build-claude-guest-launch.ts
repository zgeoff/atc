import type { SpawnPlan } from '@atc/plugin-api';
import { SESSION_SCRATCH_FOLDER } from '../scratch/session-scratch-folder';
import { CLAUDE_CONFIG_BUNDLE_FOLDER } from './claude-config-bundle-folder';
import { CLAUDE_CONFIG_SEED_FILE } from './claude-config-seed-file';

const CLAUDE_CONFIG_FOLDER = 'claude-config';
const SEEN_OFFER_KEY = 'hasSeenAutoModeOutsideReadPrompt';
const COLON = '[[:space:]]*:[[:space:]]*';
const SEEN_OFFER_SET_SED = `s/"${SEEN_OFFER_KEY}"${COLON}false/"${SEEN_OFFER_KEY}": true/`;

// The CLI opens the config's top-level object on the file's first line, empty or not.
const SEEN_OFFER_ADD_SED = [
  `1s/^\\([[:space:]]*\\){[[:space:]]*}/\\1{"${SEEN_OFFER_KEY}": true}/`,
  't',
  `1s/^\\([[:space:]]*\\){/\\1{"${SEEN_OFFER_KEY}": true,/`,
].join('\n');

const SEEN_OFFER_STEP = `{ grep -q '"${SEEN_OFFER_KEY}"${COLON}true' "$1/.claude.json" || { (umask 077 && if grep -q '"${SEEN_OFFER_KEY}"' "$1/.claude.json"; then sed -e '${SEEN_OFFER_SET_SED}' "$1/.claude.json"; else sed -e '${SEEN_OFFER_ADD_SED}' "$1/.claude.json"; fi > "$1/.claude.json.atc") && mv "$1/.claude.json.atc" "$1/.claude.json"; }; }`;
const SEEN_OFFER_CHECK = `{ grep -q '"${SEEN_OFFER_KEY}"${COLON}true' "$1/.claude.json" || echo "atc: could not mark the outside-read offer seen in $1/.claude.json, so Claude may stop to ask once" >&2; }`;
const TOKEN_FILE_ARGUMENT = '$6';
const READ_TOKEN_STEP = `{ { CLAUDE_CODE_OAUTH_TOKEN=$(cat "${TOKEN_FILE_ARGUMENT}") && [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && export CLAUDE_CODE_OAUTH_TOKEN; } || { echo "atc: cannot read the stored sign-in token ${TOKEN_FILE_ARGUMENT}, so Claude does not start" >&2; exit 78; }; }`;

const SEED_CONFIG_STEPS = [
  'mkdir -p "$1"',
  'mkdir -p "$5"',
  'chmod 700 "$5"',
  '{ [ -e "$1/.claude.json" ] || cp "$2" "$1/.claude.json"; }',
  SEEN_OFFER_STEP,
  SEEN_OFFER_CHECK,
  '{ [ ! -d "$4" ] || { rm -rf "$1/.credentials.json" "$1/CLAUDE.md" "$1/settings.json" "$1/statusline.sh" "$1/agents" "$1/output-styles" "$1/skills" && cp -R "$4/." "$1/" && rm -rf "$3"; }; }',
];

export interface BuildClaudeGuestLaunchOptions {
  readonly tokenFile?: string;
  readonly refusedEnv?: readonly string[];
  readonly bundleKey?: string;
  readonly unsetEnv?: readonly string[];
}

export function buildClaudeGuestLaunch(
  guestDir: string,
  argv: readonly string[],
  options: BuildClaudeGuestLaunchOptions = {},
): SpawnPlan & {
  readonly env: { readonly CLAUDE_CONFIG_DIR: string; readonly TMPDIR: string };
} {
  const configDir = `${guestDir}/${CLAUDE_CONFIG_FOLDER}`;
  const scratch = `${guestDir}/${SESSION_SCRATCH_FOLDER}`;
  const guards = (options.refusedEnv ?? []).map((name) => buildEnvGuard(name)).join('');
  const unsets = buildUnsetStep(options.unsetEnv ?? []);
  const bundleKey = options.bundleKey ?? 'none';
  const tokenFile = options.tokenFile;

  const script = [
    ...SEED_CONFIG_STEPS,
    ...(tokenFile === undefined ? [] : [READ_TOKEN_STEP]),
    `shift ${tokenFile === undefined ? 5 : 6}`,
    'exec "$@"',
  ].join(' && ');

  return {
    bin: 'sh',
    args: [
      '-c',
      `${guards}${unsets}${script}`,
      'sh',
      configDir,
      `${guestDir}/${CLAUDE_CONFIG_SEED_FILE}`,
      `${guestDir}/${CLAUDE_CONFIG_BUNDLE_FOLDER}`,
      `${guestDir}/${CLAUDE_CONFIG_BUNDLE_FOLDER}/${bundleKey}`,
      scratch,
      ...(tokenFile === undefined ? [] : [tokenFile]),
      ...argv,
    ],
    env: { CLAUDE_CONFIG_DIR: configDir, TMPDIR: scratch },
  };
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;

// 78 is EX_CONFIG in sysexits.h: a configuration error.
const REFUSED_EXIT = 78;

function buildEnvGuard(name: string): string {
  if (!ENV_NAME.test(name)) {
    throw new Error(`refused variable ${name} is not an environment variable name`);
  }

  return `[ -z "\${${name}+x}" ] || { echo "atc: ${name} is set in this host's environment and overrides the sign-in atc gives this session, so Claude does not start" >&2; exit ${REFUSED_EXIT}; }; `;
}

function buildUnsetStep(names: readonly string[]): string {
  const invalid = names.find((name) => !ENV_NAME.test(name));

  if (invalid !== undefined) {
    throw new Error(`unset variable ${invalid} is not an environment variable name`);
  }

  return names.length === 0 ? '' : `unset ${names.join(' ')}; `;
}
