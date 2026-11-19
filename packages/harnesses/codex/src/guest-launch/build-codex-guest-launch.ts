import type { SpawnPlan } from '@atc/plugin-api';
import { CODEX_CREDENTIAL_VARIABLES } from '../config/codex-credential-variables';
import { CODEX_TRUST_SEED_FILE } from '../trust-seed/codex-trust-seed-file';

const CODEX_HOME_FOLDER = 'codex-home';

const SEED_HOME_SCRIPT = [
  '( umask 077 && mkdir -p "$1" && cp "$2/auth.json" "$1/auth.json" )',
  'cp "$2/config.toml" "$1/config.toml"',
  '{ [ ! -f "$3" ] || cat "$3" >> "$1/config.toml"; }',
  'cp "$2/hooks.json" "$1/hooks.json"',
  'shift 3',
  `unset ${CODEX_CREDENTIAL_VARIABLES.join(' ')}`,
  'exec "$@"',
].join(' && ');

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
