import { decodeGatewayCursor } from './decode-gateway-cursor';
import type { GatewayRegistry } from './types';

/**
 * Where one daemon's part of an events read starts: after its own cursor,
 * or at its latest events for null, which only a read without a gateway
 * cursor gets; or at its newest event, for a daemon a given gateway cursor
 * leaves out, such as one added to the registry since. The caller reads
 * such a daemon once with `events.read` at limit 1 and no cursor, and
 * pins it at the cursor that answer returns, which is its newest event,
 * or event 0 for an empty trail; the read then reports it under `started`.
 * A daemon whose part the cursor holds as null, because it has not answered
 * since the read that started the cursor, starts at its latest events, as a
 * first read does: the caller reads it without a cursor, checks whether
 * older events precede that page, and the read reports it under `started`,
 * and under `truncated` when older events went unread.
 */
export type EventReadStart =
  | { readonly kind: 'after'; readonly cursor: string | null }
  | { readonly kind: 'newest' }
  | { readonly kind: 'latest' };

/**
 * The daemons an events read asks, each with where its part starts. A read
 * filtered to a session asks only the daemon that owns the session; any
 * other read asks every daemon in the registry. Without a gateway cursor
 * every daemon starts at the start of its trail, as a daemon read without
 * a cursor does.
 */
export function planEventReads(
  cursor: string | null,
  filter: string,
  sessionDaemon: string | null,
  registry: GatewayRegistry,
): ReadonlyMap<string, EventReadStart> {
  const names = sessionDaemon === null ? [...registry.daemons.keys()] : [sessionDaemon];
  const parts = cursor === null ? null : decodeGatewayCursor(cursor, filter, registry);

  const plan = new Map<string, EventReadStart>();

  for (const name of names) {
    if (parts === null) {
      plan.set(name, { kind: 'after', cursor: null });
    } else if (parts.get(name) === null) {
      plan.set(name, { kind: 'latest' });
    } else if (parts.has(name)) {
      plan.set(name, { kind: 'after', cursor: parts.get(name) ?? null });
    } else {
      plan.set(name, { kind: 'newest' });
    }
  }

  return plan;
}
