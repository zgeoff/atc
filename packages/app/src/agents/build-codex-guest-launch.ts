import type { SpawnPlan } from './agent-adapter';
import { CODEX_TRUST_SEED_FILE } from './codex-trust-seed-file';

/**
 * The launch of a Codex CLI that runs in a remote host with a Codex home of
 * the session's own inside its guest folder, so no sign-in or setting of
 * the host's image reaches it. The folder persists for the session, so a
 * resume finds the sessions Codex recorded there. Before each run a shell
 * copies in the sign-in file, the config, and the hook file staged under
 * `authDir`, a folder of the guest folder, appends the clone trust seed to
 * that config when the guest folder holds one, and unsets every variable
 * that would sign Codex in another way. `argv` is the CLI's own command
 * line.
 */
export function buildCodexGuestLaunch(
  guestDir: string,
  authDir: string,
  argv: readonly string[],
): SpawnPlan & { readonly env: { readonly CODEX_HOME: string } } {
  const codexHome = `${guestDir}/${CODEX_HOME_FOLDER}`;

  return {
    bin: 'sh',
    args: [
      '-c',
      SEED_HOME_SCRIPT,
      'sh',
      codexHome,
      `${guestDir}/${authDir}`,
      `${guestDir}/${CODEX_TRUST_SEED_FILE}`,
      ...argv,
    ],
    env: { CODEX_HOME: codexHome },
  };
}

const CODEX_HOME_FOLDER = 'codex-home';

// Variables Codex takes a credential from ahead of its sign-in file.
const CREDENTIAL_VARIABLES = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'];

// The arguments are the Codex home, the staged folder, the trust seed, and
// the CLI's own command line. The home and its sign-in file are its
// owner's alone; the CLI itself starts under the host's own umask.
const SEED_HOME_SCRIPT = [
  '( umask 077 && mkdir -p "$1" && cp "$2/auth.json" "$1/auth.json" )',
  'cp "$2/config.toml" "$1/config.toml"',
  '{ [ ! -f "$3" ] || cat "$3" >> "$1/config.toml"; }',
  'cp "$2/hooks.json" "$1/hooks.json"',
  'shift 3',
  `unset ${CREDENTIAL_VARIABLES.join(' ')}`,
  'exec "$@"',
].join(' && ');
