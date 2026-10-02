/**
 * Reduces a configured public URL to the bare origin the server is reached
 * at: https, or http only on a loopback host, with no path, query, or
 * fragment. The origin is the OAuth issuer, and `<origin>/mcp` is the
 * resource every grant is bound to.
 */
export function normalizePublicURL(raw: string): string {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Error(`the public URL '${raw}' is not a URL`);
  }

  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error(`the public URL '${raw}' must use https unless its host is loopback`);
  }

  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    throw new Error(
      `the public URL '${raw}' must be a bare origin, with no path, query, or fragment`,
    );
  }

  if (url.username !== '' || url.password !== '') {
    throw new Error(`the public URL '${raw}' must not carry credentials`);
  }

  return url.origin;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}
