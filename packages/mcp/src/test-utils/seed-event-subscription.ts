import invariant from 'tiny-invariant';
import { createSubscriptionStore } from '../events/create-subscription-store';
import type { SubscriptionRow } from '../events/create-subscription-store';
import { buildMockSubscriptionRow } from './build-mock-subscription-row';
import type { MCPAuthSeedDeps } from './types';

export async function seedEventSubscription(
  deps: MCPAuthSeedDeps,
  input: Partial<SubscriptionRow> = {},
): Promise<SubscriptionRow> {
  const now = deps.clock.now();
  const row = buildMockSubscriptionRow({ created_at: new Date(now).toISOString(), ...input });

  const started = await createSubscriptionStore(deps.db).start(row, now);

  invariant(started);

  return row;
}
