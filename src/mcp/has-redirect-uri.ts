/**
 * Whether a requested redirect URI matches one the client registered. The
 * match is exact, except that a loopback redirect may name any port, since a
 * native client binds whichever port is free.
 */
export function hasRedirectURI(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) {
    return true;
  }

  const wanted = findLoopbackURL(requested);

  if (wanted === null) {
    return false;
  }

  return registered.some((uri) => {
    const candidate = findLoopbackURL(uri);

    return (
      candidate !== null &&
      candidate.protocol === wanted.protocol &&
      candidate.hostname === wanted.hostname &&
      candidate.pathname === wanted.pathname &&
      candidate.search === wanted.search
    );
  });
}

function findLoopbackURL(raw: string): URL | null {
  try {
    const url = new URL(raw);

    return url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
      ? url
      : null;
  } catch {
    return null;
  }
}
