import type { SubscriptionStore } from '../events/create-subscription-store';

// Stands in for a subscribe that lands at the worst moment: each read that
// finds an expired subscription runs `between` before it returns, so the
// caller's next write meets a row that changed after its read.
export function buildStubRacingSubscriptionStore(
  store: SubscriptionStore,
  between: () => Promise<void>,
): SubscriptionStore {
  return {
    ...store,
    read: async (subscriptionID, now) => {
      const stored = await store.read(subscriptionID, now);

      if (stored?.state === 'expired') {
        await between();
      }

      return stored;
    },
  };
}
