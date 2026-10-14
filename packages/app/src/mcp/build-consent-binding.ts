/**
 * The parts of an authorization request that stay the same from its login
 * page to its consent page: the client, where it returns, the scopes and
 * resource it asks for, its state, and its PKCE challenge. better-auth
 * signs each page's query afresh, so the binding between a passkey sign-in
 * and the consent it allows is built from these.
 */
export function buildConsentBinding(oauthQuery: string): string {
  const params = new URLSearchParams(oauthQuery);

  return JSON.stringify(
    ['client_id', 'redirect_uri', 'scope', 'resource', 'state', 'code_challenge'].map(
      (name) => params.get(name) ?? '',
    ),
  );
}
