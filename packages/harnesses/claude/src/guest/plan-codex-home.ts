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

interface PlanCodexHomeOptions {
  readonly authProfiles: Config['authProfiles'];
  readonly selected: readonly string[];
  readonly guestDir: string;
  readonly revisionFolder: string;
  readonly states: Readonly<Record<string, GuestOAuthState>>;
  readonly telemetryHost: string | null;
}

export function planCodexHome(options: PlanCodexHomeOptions): CodexHomePlan {
  const secret = findChatGPTSecret(options.authProfiles, options.selected);
  const signIn = secret === null ? null : findCodexSignIn(options.states[secret]);

  if (signIn === null) {
    return { files: {}, env: {}, unsetEnv: [] };
  }

  const home = `${options.revisionFolder}/${CODEX_HOME_FOLDER}`;

  return {
    files: {
      [`${home}/auth.json`]: {
        content: new TextEncoder().encode(buildCodexAuthFile(signIn.idClaims, signIn.accountID)),
        mode: 0o600,
      },
      [`${home}/config.toml`]: buildCodexConfig(options.telemetryHost),
    },
    env: { CODEX_HOME: `${options.guestDir}/${home}` },
    unsetEnv: CREDENTIAL_VARIABLES,
  };
}

const CHATGPT_HOST = 'chatgpt.com';

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
