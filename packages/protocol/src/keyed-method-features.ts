import type { DaemonFeature } from './daemon-features';

export const KEYED_METHOD_FEATURES: ReadonlyMap<string, DaemonFeature> = new Map<
  string,
  DaemonFeature
>([
  ['session.spawn', 'spawn.idempotency'],
  ['session.message', 'message.idempotency'],
]);
