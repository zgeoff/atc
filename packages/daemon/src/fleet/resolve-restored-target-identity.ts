import type { FleetEntry } from '@atc/store';
import type { ExecutionTarget } from './build-execution-targets';
import { isUnconfirmedBinding } from './is-unconfirmed-binding';

export async function resolveRestoredTargetIdentity(
  target: ExecutionTarget | undefined,
  entry: FleetEntry,
): Promise<string | undefined> {
  const identity = entry.targetIdentity;

  if (
    target === undefined ||
    identity === undefined ||
    !isUnconfirmedBinding(target, identity) ||
    target.provider?.checkExistingHost === undefined
  ) {
    return identity;
  }

  const reachable = await target.provider.checkExistingHost(entry.hostKey ?? entry.sessionID);

  return reachable ? target.identity : identity;
}
