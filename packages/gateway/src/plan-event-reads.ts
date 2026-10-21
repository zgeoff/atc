import { decodeGatewayCursor } from './decode-gateway-cursor';
import type { GatewayRegistry } from './types';

export type EventReadStart =
  | { readonly kind: 'after'; readonly cursor: string | null }

  // pinned at its newest event, for a daemon the cursor leaves out
  | { readonly kind: 'newest' }

  // read without a cursor and reported as started, for a daemon the cursor holds as null
  | { readonly kind: 'latest' };

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
