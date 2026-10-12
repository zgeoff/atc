/**
 * The `auth.json` a Codex session on a remote host signs in with, which
 * holds no credential: impd's broker sets the real access token on each
 * request to chatgpt.com. Codex reads a ChatGPT sign-in from it with no
 * sign-in step when the access token is opaque, so it never refreshes the
 * token at start, and the last refresh lies far ahead, so it never
 * refreshes on age. The ID token carries the email and the OpenAI auth
 * claims of impd's ID token and nothing else, under an unsigned header,
 * since Codex reads its claims and never checks a signature. The account
 * id must be the real one: Codex sends it with every request and checks
 * it against the account's workspaces before each session.
 */
export function buildCodexAuthFile(
  idClaims: Readonly<Record<string, unknown>>,
  accountID: string,
): string {
  const auth = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: buildUnsignedIDToken(idClaims),
      access_token: PLACEHOLDER,
      refresh_token: PLACEHOLDER,
      account_id: accountID,
    },
    last_refresh: LAST_REFRESH,
  };

  return `${JSON.stringify(auth, null, 2)}\n`;
}

// The value impd's broker replaces with the access token on the host's side.
const PLACEHOLDER = 'imp-broker-placeholder';

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
    toBase64URL(PLACEHOLDER),
  ].join('.');
}

function toBase64URL(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}
