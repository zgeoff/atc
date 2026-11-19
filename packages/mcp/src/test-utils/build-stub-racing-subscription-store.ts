import type { SubscriptionStore } from '../events/create-subscription-store';

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
