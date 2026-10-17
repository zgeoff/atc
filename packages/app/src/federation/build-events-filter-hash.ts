import { createHash } from 'node:crypto';

export function buildEventsFilterHash(
  session: string | null,
  kinds: readonly string[] | null,
): string {
  const canonical = JSON.stringify([session, kinds === null ? null : kinds.toSorted()]);

  return createHash('sha256').update(canonical).digest('base64url').slice(0, 22);
}
