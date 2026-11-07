import { seedGrantID } from './seed-grant-id';
import type { GrantIDInput } from './seed-grant-id';
import type { MCPAuthSeedDeps } from './types';

export function buildGrantSeeder(deps: Pick<MCPAuthSeedDeps, 'db'>) {
  return {
    grantID: (input: GrantIDInput) => seedGrantID(deps, input),
  };
}
