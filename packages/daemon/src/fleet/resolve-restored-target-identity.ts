import type { FleetEntry } from '@atc/store';
import type { ExecutionTarget } from './build-execution-targets';

export async function resolveRestoredTargetIdentity(
  target: ExecutionTarget | undefined,
  entry: FleetEntry,
): Promise<string | undefined> {
  const identity = entry.targetIdentity;

  // only an unversioned imp binding is confirmed against an existing host
  if (
    target?.kind !== 'imp' ||
    identity === undefined ||
    !/^imp:[\da-f]{16}$/u.test(identity) ||
    target.provider?.checkExistingHost === undefined
  ) {
    return identity;
  }

  const reachable = await target.provider.checkExistingHost(entry.hostKey ?? entry.sessionID);

  return reachable ? target.identity : identity;
}
