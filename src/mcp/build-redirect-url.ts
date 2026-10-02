/**
 * The URL an authorization response sends the browser to: the client's
 * redirect URI with the response parameters added, plus `iss` holding the
 * issuer on every response (RFC 9207). A null parameter is left out.
 */
export function buildRedirectURL(
  redirectURI: string,
  params: Readonly<Record<string, string | null>>,
  issuer: string,
): string {
  const url = new URL(redirectURI);

  for (const [key, value] of Object.entries(params)) {
    if (value !== null) {
      url.searchParams.set(key, value);
    }
  }

  url.searchParams.set('iss', issuer);

  return url.href;
}
