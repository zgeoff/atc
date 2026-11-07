import type { SubscriptionRow } from '../events/create-subscription-store';
import { seedEventSubscription } from './seed-event-subscription';
import type { MCPAuthSeedDeps } from './types';

export function buildEventSubscriptionSeeder(deps: MCPAuthSeedDeps) {
  return {
    eventSubscription: (input?: Partial<SubscriptionRow>) => seedEventSubscription(deps, input),
  };
}
