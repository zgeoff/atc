// one folder per binding revision, so a launch under a newer binding never
// reads an older one's settings.
export function buildAuthRevisionFolder(revision: number): string {
  return `auth-r${revision}`;
}
