// The path a session's live terminal answers at.
const PTY_PATH = /^\/sessions\/(?<id>[^/]+)\/pty$/u;

export function findPTYSessionID(path: string): string | null {
  const id = PTY_PATH.exec(path)?.groups?.['id'];

  return id === undefined ? null : decodeURIComponent(id);
}
