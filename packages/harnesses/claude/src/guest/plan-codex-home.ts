import type { Config } from '@atc/config';
import { resolveAuthProfiles } from '@atc/config';
import type { GuestFile, GuestOAuthState } from '@atc/plugin-api';
import { buildCodexAuthFile, buildCodexConfig, findCodexSignIn } from '@atc/plugin-api';

interface CodexHomePlan {
  readonly files: Readonly<Record<string, GuestFile>>;
  readonly env: Readonly<Record<string, string>>;
  readonly unsetEnv: readonly string[];
}

const CODEX_HOME_FOLDER = 'codex-home';

// Variables Codex takes a credential from ahead of its sign-in file.
const CREDENTIAL_VARIABLES = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'];

// the home replaces the image's own Codex home, its settings included; without a ready
// chatgpt.com sign-in Codex keeps the image's sign-in
export function planCodexHome(
  authProfiles: Config['authProfiles'],
  selected: readonly string[],
  guestDir: string,
  revisionFolder: string,
  states: Readonly<Record<string, GuestOAuthState>>,
): CodexHomePlan {
  const secret = findChatGPTSecret(authProfiles, selected);
  const signIn = secret === null ? null : findCodexSignIn(states[secret]);

  if (signIn === null) {
    return { files: {}, env: {}, unsetEnv: [] };
  }

  const home = `${revisionFolder}/${CODEX_HOME_FOLDER}`;

  return {
    files: {
      [`${home}/auth.json`]: {
        content: new TextEncoder().encode(buildCodexAuthFile(signIn.idClaims, signIn.accountID)),
        mode: 0o600,
      },
      [`${home}/config.toml`]: buildCodexConfig(),
    },
    env: { CODEX_HOME: `${guestDir}/${home}` },
    unsetEnv: CREDENTIAL_VARIABLES,
  };
}

// The host Codex sends its ChatGPT sign-in to.
const CHATGPT_HOST = 'chatgpt.com';

// The oauth secret the selected profiles send to chatgpt.com as a bearer
// authorization header, where Codex sends its access token, or null when
// they send none or no longer resolve.
function findChatGPTSecret(
  authProfiles: Config['authProfiles'],
  selected: readonly string[],
): string | null {
  const resolution = resolveAuthProfiles(authProfiles, selected);

  if ('problem' in resolution) {
    return null;
  }

  const found = resolution.resolved.secrets.find(
    (secret) =>
      secret.kind === 'oauth' &&
      secret.rules.some(
        (rule) =>
          rule.host === CHATGPT_HOST && rule.header === 'authorization' && rule.scheme === 'bearer',
      ),
  );

  return found?.secret ?? null;
}
