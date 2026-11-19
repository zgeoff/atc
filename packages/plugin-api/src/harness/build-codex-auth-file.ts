import { BROKER_PLACEHOLDER } from '@atc/core';

// Far-future date so Codex never treats the token as stale and refreshes it.
const LAST_REFRESH = '2099-01-01T00:00:00Z';

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

      // The broker sets the real token on each request to chatgpt.com. An
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

const KEPT_CLAIMS = ['email', 'https://api.openai.com/auth'] as const;

// Codex needs three non-empty segments, so the signature segment holds a placeholder.
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
