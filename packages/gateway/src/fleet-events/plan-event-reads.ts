import type { GatewayRegistry } from '../types';
import { decodeGatewayCursor } from './decode-gateway-cursor';

export type EventReadStart =
  | { readonly kind: 'after'; readonly cursor: string | null }
  | { readonly kind: 'newest' }
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
