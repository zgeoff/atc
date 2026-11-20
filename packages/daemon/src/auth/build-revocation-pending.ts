import type { SessionID } from '@atcx/contract';
import { AtcError } from '@atcx/contract/light';

export function buildRevocationPending(hostKey: SessionID, pending: readonly string[]): AtcError {
  return new AtcError(
    'auth_revocation_pending',
    `revocation pending for host ${hostKey}, owner intervention needed: atc could not confirm ${pending.join(', ')} gone, and launches stay blocked`,
    { host: hostKey, pending },
  );
}
