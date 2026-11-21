const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;

// A place key must match across daemons, so two spellings of one service URL have to agree.
// The URL parser lowercases only the host of a scheme it knows, such as https, and parses a
// string with no `scheme://`, such as `host:443`, as a scheme and a path.
export function formatPlaceURL(url: string): string {
  const trimmed = url.trim();
  const parsed = HAS_SCHEME.test(trimmed) ? URL.parse(trimmed) : null;

  if (parsed === null) {
    return trimmed;
  }

  const credentials =
    parsed.password === '' ? parsed.username : `${parsed.username}:${parsed.password}`;

  const userInfo = credentials === '' ? '' : `${credentials}@`;
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  const port = parsed.port === '' ? '' : `:${parsed.port}`;
  const path = parsed.pathname.replace(/\/+$/u, '');

  return `${parsed.protocol}//${userInfo}${host}${port}${path}${parsed.search}${parsed.hash}`;
}
