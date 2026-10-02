/**
 * Whether a client may register a redirect URI: https, or http on a loopback
 * host, with no fragment and no credentials.
 */
export function isAllowedRedirectURI(raw: string): boolean {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.hash !== '' || url.username !== '' || url.password !== '') {
    return false;
  }

  return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname));
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}
