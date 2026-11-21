const URL_PARTS =
  /^(?<scheme>[a-z][a-z0-9+.-]*):\/\/(?<userInfo>[^/?#@]*@)?(?<host>[^/?#]*)(?<rest>.*)$/iu;

// A place key must match across daemons, so two spellings of one service URL have to agree:
// the scheme and host lose their case, and the URL loses its trailing slashes.
export function formatPlaceURL(url: string): string {
  const parts = URL_PARTS.exec(url.trim())?.groups;

  if (parts === undefined) {
    return url.trim();
  }

  const scheme = (parts['scheme'] ?? '').toLowerCase();
  const host = (parts['host'] ?? '').toLowerCase();

  return `${scheme}://${parts['userInfo'] ?? ''}${host}${(parts['rest'] ?? '').replace(/\/+$/u, '')}`;
}
