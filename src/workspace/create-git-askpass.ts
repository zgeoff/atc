import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GitCredential {
  readonly kind: 'env';
  readonly name: string;
}

interface GitAskpass {
  readonly ok: true;

  // What each network git command takes: the variables that point it at
  // the helper, and the arguments that switch the host's credential
  // helpers off.
  readonly env: Readonly<Record<string, string>>;
  readonly args: readonly string[];
  [Symbol.asyncDispose]: () => Promise<void>;
}

interface MissingCredential {
  readonly ok: false;
  readonly code: 'credential_missing';
  readonly message: string;
}

const ASKPASS_SECRET_VAR = 'ATC_GIT_ASKPASS_SECRET';

// Username prompts get a fixed name that GitHub and GitLab both accept
// alongside a token; password prompts get the token.
const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  Username*) printf '%s\\n' x-access-token ;;
  *) printf '%s\\n' "$${ASKPASS_SECRET_VAR}" ;;
esac
`;

/**
 * Selects how network git commands authenticate. Without a credential they
 * authenticate through the host's own git config, and the result adds
 * nothing. An env credential is read from the named variable and handed to
 * git only through a private askpass helper, never through the command line
 * or the URL, with the host's credential helpers switched off so none of
 * them stores the token. Disposing the result deletes the helper.
 */
export async function createGitAskpass(
  credential: GitCredential | undefined,
): Promise<GitAskpass | MissingCredential> {
  if (credential === undefined) {
    return { ok: true, env: {}, args: [], [Symbol.asyncDispose]: async () => {} };
  }

  const secret = process.env[credential.name];

  if (secret === undefined || secret === '') {
    return {
      ok: false,
      code: 'credential_missing',
      message: 'the credential environment variable is unset or empty',
    };
  }

  const dir = await mkdtemp(join(tmpdir(), 'atc-askpass-'));

  const helper = join(dir, 'askpass');

  await writeFile(helper, ASKPASS_SCRIPT, { mode: 0o700 });

  return {
    ok: true,
    env: { GIT_ASKPASS: helper, [ASKPASS_SECRET_VAR]: secret },
    args: ['-c', 'credential.helper='],
    [Symbol.asyncDispose]: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
