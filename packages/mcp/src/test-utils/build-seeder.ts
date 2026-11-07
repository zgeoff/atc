import { buildEventSubscriptionSeeder } from './build-event-subscription-seeder';
import { buildPasskeySeeder } from './build-passkey-seeder';
import type { MCPAuthSeedDeps } from './types';

export type TestDeps = MCPAuthSeedDeps;

export function buildSeeder(deps: TestDeps) {
  return { ...buildPasskeySeeder(deps), ...buildEventSubscriptionSeeder(deps) };
}
