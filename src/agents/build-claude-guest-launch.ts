import type { SpawnPlan } from './agent-adapter';
import { CLAUDE_CONFIG_BUNDLE_FOLDER } from './claude-config-bundle-folder';
import { CLAUDE_CONFIG_SEED_FILE } from './claude-config-seed-file';
import { SESSION_SCRATCH_FOLDER } from './session-scratch-folder';

/**
 * The launch of a Claude CLI that runs in a remote host with a config
 * folder of the session's own inside its guest folder, so no account or
 * setting of the host's image reaches it. A shell copies the seed into the
 * folder only when the folder holds no `.claude.json` yet, then runs the
 * CLI, so a resumed session keeps the state the CLI wrote, a folder trust
 * a person accepted included. A `.claude.json` an earlier run left takes
 * the mark that the CLI's one-time offer to block reads outside the
 * working directories was seen, so an unattended session never waits on
 * that offer. The shell also creates the session's scratch folder in the
 * guest folder, which the CLI takes as its temporary folder. When the
 * guest folder holds the config bundle
 * staged under `bundleKey`, the shell replaces the bundle's entries in the
 * config folder with the staged ones and removes every staged bundle, so
 * each launch reads the bundle its own transfer carried and never one an
 * earlier launch left. `argv` is the CLI's own command line. The
 * shell exits before it runs the CLI when the host's environment sets any
 * of `refusedEnv`, which must be variable names, and says which one.
 */
export function buildClaudeGuestLaunch(
  guestDir: string,
  argv: readonly string[],
  refusedEnv: readonly string[] = [],
  bundleKey = 'none',
): SpawnPlan & {
  readonly env: { readonly CLAUDE_CONFIG_DIR: string; readonly TMPDIR: string };
} {
  const configDir = `${guestDir}/${CLAUDE_CONFIG_FOLDER}`;
  const scratch = `${guestDir}/${SESSION_SCRATCH_FOLDER}`;
  const guards = refusedEnv.map((name) => buildEnvGuard(name)).join('');

  return {
    bin: 'sh',
    args: [
      '-c',
      `${guards}${SEED_CONFIG_SCRIPT}`,
      'sh',
      configDir,
      `${guestDir}/${CLAUDE_CONFIG_SEED_FILE}`,
      `${guestDir}/${CLAUDE_CONFIG_BUNDLE_FOLDER}`,
      `${guestDir}/${CLAUDE_CONFIG_BUNDLE_FOLDER}/${bundleKey}`,
      scratch,
      ...argv,
    ],
    env: { CLAUDE_CONFIG_DIR: configDir, TMPDIR: scratch },
  };
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;

// A shell step that stops the launch when the variable is set, empty or
// not, with a line that says which variable and why.
function buildEnvGuard(name: string): string {
  if (!ENV_NAME.test(name)) {
    throw new Error(`refused variable ${name} is not an environment variable name`);
  }

  return `[ -z "\${${name}+x}" ] || { echo "atc: ${name} is set in this host's environment and overrides the sign-in atc gives this session, so Claude does not start" >&2; exit ${REFUSED_EXIT}; }; `;
}

// sysexits' EX_CONFIG: a configuration error.
const REFUSED_EXIT = 78;
const CLAUDE_CONFIG_FOLDER = 'claude-config';

// The key the CLI's global config holds once its one-time offer to block
// reads outside the working directories was seen.
const SEEN_OFFER_KEY = 'hasSeenAutoModeOutsideReadPrompt';

// Sets the key to true in a config that holds it as false.
const SEEN_OFFER_SET_SED = `s/"${SEEN_OFFER_KEY}": *false/"${SEEN_OFFER_KEY}": true/`;

// Adds the key at the start of the config's top-level object, which the
// CLI opens on the file's first line, empty or not.
const SEEN_OFFER_ADD_SED = [
  `1s/^\\([[:space:]]*\\){[[:space:]]*}/\\1{"${SEEN_OFFER_KEY}": true}/`,
  't',
  `1s/^\\([[:space:]]*\\){/\\1{"${SEEN_OFFER_KEY}": true,/`,
].join('\n');

// A config that holds the key as true stays as it is. Any other one is
// rewritten beside itself, readable by its owner alone, and moved into
// place.
const SEEN_OFFER_STEP = `{ grep -q '"${SEEN_OFFER_KEY}": *true' "$1/.claude.json" || { (umask 077 && if grep -q '"${SEEN_OFFER_KEY}"' "$1/.claude.json"; then sed -e '${SEEN_OFFER_SET_SED}' "$1/.claude.json"; else sed -e '${SEEN_OFFER_ADD_SED}' "$1/.claude.json"; fi > "$1/.claude.json.atc") && mv "$1/.claude.json.atc" "$1/.claude.json"; }; }`;

// The arguments are the config folder, the seed, the folder bundles stage
// in, this launch's staged bundle, the scratch folder, and the CLI's own
// command line. The removed entries are every top-level entry a bundle can
// hold, so one the host dropped leaves the config folder too.
const SEED_CONFIG_SCRIPT = [
  'mkdir -p "$1"',
  'mkdir -p -m 700 "$5"',
  '{ [ -e "$1/.claude.json" ] || cp "$2" "$1/.claude.json"; }',
  SEEN_OFFER_STEP,
  '{ [ ! -d "$4" ] || { rm -rf "$1/CLAUDE.md" "$1/settings.json" "$1/statusline.sh" "$1/agents" "$1/output-styles" "$1/skills" && cp -R "$4/." "$1/" && rm -rf "$3"; }; }',
  'shift 5',
  'exec "$@"',
].join(' && ');
