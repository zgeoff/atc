import { createHash } from 'node:crypto';

interface SubscriptionKey {
  readonly clientID: string;
  readonly url: string;
  readonly name: string;

  // The subscription's arguments as canonical JSON.
  readonly arguments: string;
}

// The Events extension derives a subscription's id from its key, so a refresh
// and a restart give the same id, and the id grants nothing to whoever sees it.
export function buildSubscriptionID(key: SubscriptionKey): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([key.clientID, key.url, key.name, key.arguments]))
    .digest('hex');

  return `sub_${digest.slice(0, 32)}`;
}
