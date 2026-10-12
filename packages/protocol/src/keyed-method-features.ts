import type { DaemonFeature } from './daemon-features';

/**
 * The feature a daemon announces when it runs a keyed request method at
 * most once under its idempotency key. A caller sends a key, or retries
 * under one, only to a daemon that announces the method's feature.
 */
export const KEYED_METHOD_FEATURES: ReadonlyMap<string, DaemonFeature> = new Map<
  string,
  DaemonFeature
>([
  ['session.spawn', 'spawn.idempotency'],
  ['session.message', 'message.idempotency'],
]);
