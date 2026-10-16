// What a session whose harness launched under an older runtime auth
// revision shows until its next launch.
export function formatAuthNotice(revision: number): string {
  return `auth revision ${String(revision)} applies at the next launch`;
}
