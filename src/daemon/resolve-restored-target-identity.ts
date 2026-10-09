import type { FleetEntry } from '../store/fleet-entry';
import type { ExecutionTarget } from './build-execution-targets';

/**
 * Resolves a stored imp binding to the connection identity only after the
 * provider confirms the existing host through its current credentials.
 * A missing or unreachable host keeps its stored identity and refuses work.
 */
export async function resolveRestoredTargetIdentity(
  target: ExecutionTarget | undefined,
  entry: FleetEntry,
): Promise<string | undefined> {
  const identity = entry.targetIdentity;

  if (
    target?.kind !== 'imp' ||
    identity === undefined ||
    !/^imp:[\da-f]{16}$/.test(identity) ||
    target.provider?.checkExistingHost === undefined
  ) {
    return identity;
  }

  const reachable = await target.provider.checkExistingHost(entry.hostKey ?? entry.sessionID);

  return reachable ? target.identity : identity;
}
