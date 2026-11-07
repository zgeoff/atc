import { seedPasskey } from './seed-passkey';
import type { PasskeyInput } from './seed-passkey';
import type { MCPAuthSeedDeps } from './types';

export function buildPasskeySeeder(deps: MCPAuthSeedDeps) {
  return {
    passkey: (input?: PasskeyInput) => seedPasskey(deps, input),
  };
}
