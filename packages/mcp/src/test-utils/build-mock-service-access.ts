import type { GrantScope } from '@atcx/contract';
import type { VerifiedAccess } from '../auth/types';

// The access a service client's bearer verifies as, with the scopes the test names.
export function buildMockServiceAccess(scopes: readonly GrantScope[], name = 'ci'): VerifiedAccess {
  return {
    kind: 'service',
    clientID: `service:${name}`,
    clientName: `service:${name}`,
    scopes,
  };
}
