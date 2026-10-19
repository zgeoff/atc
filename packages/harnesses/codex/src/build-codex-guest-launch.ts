import type { SpawnPlan } from '@atc/plugin-api';
import { CODEX_TRUST_SEED_FILE } from './codex-trust-seed-file';

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

// a codex home of the session's own in its guest folder keeps the host image's sign-in and
// settings out, and lasts the session so a resume finds the threads codex recorded there
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
