import type { Config } from '@atc/config/config';
import { resolveAuthProfiles } from '@atc/config/resolve-auth-profiles';
import type { GuestFile, GuestOAuthState } from '@atc/plugin-api/agent-adapter';
import { buildCodexAuthFile } from '@atc/plugin-api/harness/build-codex-auth-file';
import { buildCodexConfig } from '@atc/plugin-api/harness/build-codex-config';
import { findCodexSignIn } from '@atc/plugin-api/harness/find-codex-sign-in';

/**
 * A Codex home for the Codex CLI that a Claude session on a remote host
 * runs as a tool, such as `codex review`: its files, keyed by their path
 * inside the guest folder, and the `CODEX_HOME` variable that points the
 * CLI at them.
 */
interface CodexHomePlan {
  readonly files: Readonly<Record<string, GuestFile>>;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Plans the Codex home of a Claude session that signs in through impd's
 * broker, in the revision folder of its auth binding. When the selected
 * profiles send an `oauth` secret to `chatgpt.com` as a bearer
 * authorization header and impd lists that secret's sign-in as ready, the
 * home holds the sign-in file a brokered Codex session gets, with no
 * credential in it, and the config that keeps the sign-in in that file.
 * Any other selection, or a sign-in that is not ready, plans no home, and
 * Codex keeps the sign-in of the host's image.
 */
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
    return { files: {}, env: {} };
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
  };
}

const CODEX_HOME_FOLDER = 'codex-home';

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
