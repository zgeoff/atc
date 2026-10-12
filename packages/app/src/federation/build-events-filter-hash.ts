import { createHash } from 'node:crypto';

/**
 * The hash a gateway events cursor holds of the filters it was read
 * under: the session filter, as the caller sent it, and the kind filter.
 * A cursor read under one filter is refused under another, since its
 * per-daemon positions only make sense for the events that filter kept.
 */
export function buildEventsFilterHash(
  session: string | null,
  kinds: readonly string[] | null,
): string {
  const canonical = JSON.stringify([session, kinds === null ? null : kinds.toSorted()]);

  return createHash('sha256').update(canonical).digest('base64url').slice(0, 22);
}
