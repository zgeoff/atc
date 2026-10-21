export function buildConsentBinding(oauthQuery: string): string {
  const params = new URLSearchParams(oauthQuery);

  // better-auth signs each page's query afresh, so the binding holds only the
  // fields that stay the same from the login page to the consent page.
  return JSON.stringify(
    ['client_id', 'redirect_uri', 'scope', 'resource', 'state', 'code_challenge'].map(
      (name) => params.get(name) ?? '',
    ),
  );
}
