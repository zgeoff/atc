import { BROKER_PLACEHOLDER } from '@atc/core';

export function buildCodexAuthFile(
  idClaims: Readonly<Record<string, unknown>>,
  accountID: string,
): string {
  const auth = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      // Codex reads the claims and never checks a signature.
      id_token: buildUnsignedIDToken(idClaims),

      // impd's broker sets the real token on each request to chatgpt.com. An
      // opaque token takes Codex past its sign-in step and refresh at start.
      access_token: BROKER_PLACEHOLDER,
      refresh_token: BROKER_PLACEHOLDER,

      // must be the real one: Codex sends it with every request and checks it
      // against the account's workspaces before each session.
      account_id: accountID,
    },
    last_refresh: LAST_REFRESH,
  };

  return `${JSON.stringify(auth, null, 2)}\n`;
}

// A last refresh Codex never counts as stale.
const LAST_REFRESH = '2099-01-01T00:00:00Z';

// The claims of impd's ID token that Codex reads: the account's email and
// the object that holds its plan and account ids.
const KEPT_CLAIMS = ['email', 'https://api.openai.com/auth'] as const;

// A JWT of three base64url segments whose header says it is unsigned and
// whose signature segment holds the placeholder, since Codex needs three
// non-empty segments.
function buildUnsignedIDToken(idClaims: Readonly<Record<string, unknown>>): string {
  const payload = Object.fromEntries(
    KEPT_CLAIMS.filter((claim) => idClaims[claim] !== undefined).map((claim) => [
      claim,
      idClaims[claim],
    ]),
  );

  return [
    toBase64URL(JSON.stringify({ alg: 'none', typ: 'JWT' })),
    toBase64URL(JSON.stringify(payload)),
    toBase64URL(BROKER_PLACEHOLDER),
  ].join('.');
}

function toBase64URL(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}
