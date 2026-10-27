// The path a session's live terminal answers at.
const PTY_PATH = /^\/sessions\/(?<id>[^/]+)\/pty$/u;

type PTYPath =
  | { readonly kind: 'other' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'session'; readonly sessionID: string };

export function parsePTYPath(path: string): PTYPath {
  const id = PTY_PATH.exec(path)?.groups?.['id'];

  if (id === undefined) {
    return { kind: 'other' };
  }

  try {
    return { kind: 'session', sessionID: decodeURIComponent(id) };
  } catch (error) {
    if (error instanceof URIError) {
      return { kind: 'malformed' };
    }

    throw error;
  }
}
