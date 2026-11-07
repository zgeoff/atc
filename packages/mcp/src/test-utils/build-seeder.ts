import { buildEventSubscriptionSeeder } from './build-event-subscription-seeder';
import type { MCPAuthSeedDeps } from './types';

export type TestDeps = MCPAuthSeedDeps;

export function buildSeeder(deps: TestDeps) {
  return { ...buildEventSubscriptionSeeder(deps) };
}
