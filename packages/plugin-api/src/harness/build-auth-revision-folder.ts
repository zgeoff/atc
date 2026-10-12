/**
 * The folder inside a session's guest folder that holds the files a
 * harness writes for one revision of the host's runtime auth binding, so
 * a launch under a newer binding never reads an older one's settings.
 */
export function buildAuthRevisionFolder(revision: number): string {
  return `auth-r${revision}`;
}
