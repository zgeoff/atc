import { buildGrantSeeder, buildPasskeySeeder } from '@atc/mcp/test-utils';
import type { MCPAuthSeedDeps } from '@atc/mcp/test-utils';

export type TestDeps = MCPAuthSeedDeps;

export function buildSeeder(deps: TestDeps) {
  return { ...buildPasskeySeeder(deps), ...buildGrantSeeder(deps) };
}
