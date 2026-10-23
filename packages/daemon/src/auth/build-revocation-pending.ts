import { DaemonError } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';

export function buildRevocationPending(
  hostKey: SessionID,
  pending: readonly string[],
): DaemonError {
  return new DaemonError(
    'auth_revocation_pending',
    `revocation pending for host ${hostKey}, owner intervention needed: atc could not confirm ${pending.join(', ')} gone, and launches stay blocked`,
    { host: hostKey, pending },
  );
}
