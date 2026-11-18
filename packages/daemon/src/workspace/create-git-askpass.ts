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
const ASKPASS_ORIGIN_VAR = 'ATC_GIT_ASKPASS_ORIGIN';

// Answers a prompt only when its URL names the origin in the origin variable, and fails git
// otherwise. A truncated prompt or a URL that parsers read differently is refused whole, and a
// default port counts as no port. Username prompts get a name GitHub and GitLab both accept.
export const ASKPASS_SCRIPT = `#!/bin/sh
q="'"
case "$1" in
  "Username for '"*"': "|"Password for '"*"': ") ;;
  *) exit 1 ;;
esac
url=\${1#*"$q"}
url=\${url%"$q"*}
case "$url" in
  *[\\\\]*|*'#'*|*'?'*|*' '*|*"$q"*) exit 1 ;;
  *://*) ;;
  *) exit 1 ;;
esac
rest=\${url#*://}
host=\${rest%%/*}
host=\${host##*@}
case "$host" in
  ''|*[!]A-Za-z0-9._:[-]*) exit 1 ;;
esac
origin=$(printf '%s' "\${url%%://*}://$host" | tr '[:upper:]' '[:lower:]')
case "$origin" in
  https://*:443) origin=\${origin%:443} ;;
  http://*:80) origin=\${origin%:80} ;;
esac
[ -n "$${ASKPASS_ORIGIN_VAR}" ] && [ "$origin" = "$${ASKPASS_ORIGIN_VAR}" ] || exit 1
case "$1" in
  Username*) printf '%s\\n' x-access-token ;;
  *) printf '%s\\n' "$${ASKPASS_SECRET_VAR}" ;;
esac
`;

export async function createGitAskpass(
  credential: GitCredential | undefined,
  sourceURL: string,
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

  const directory = await mkdtemp(join(tmpdir(), 'atc-askpass-'));

  const helper = join(directory, 'askpass');

  // A helper that cannot be written leaves no directory behind.
  try {
    await writeFile(helper, ASKPASS_SCRIPT, { mode: 0o700 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });

    throw error;
  }

  // the token reaches git only through the helper, never the command line or the URL, and the
  // host's credential helpers are off so none stores it. The helper's origin check is the guard:
  // a URL-scoped http.<url>.followRedirects in the host's git config overrides the flag.
  return {
    ok: true,
    env: {
      GIT_ASKPASS: helper,
      [ASKPASS_SECRET_VAR]: secret,
      [ASKPASS_ORIGIN_VAR]: readSourceOrigin(sourceURL),
    },
    args: ['-c', 'credential.helper=', '-c', 'http.followRedirects=false'],
    [Symbol.asyncDispose]: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// The scheme and host of the source URL, lowercased, or empty when the URL is not one a token
// may go to; the helper then refuses every prompt.
function readSourceOrigin(sourceURL: string): string {
  try {
    const url = new URL(sourceURL);

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return '';
    }

    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return '';
  }
}
