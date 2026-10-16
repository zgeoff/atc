import type { StateStore } from '@atc/store';
import type { ExecutionTarget } from './build-execution-targets';
import type { RuntimeAuthBinder } from './runtime-auth-binder';

/**
 * Settles the runtime auth bindings a stopped daemon left mid-change, each
 * through its target's broker; a host with a fleet entry is listed. A
 * failure is logged, leaves its binding blocked, and resolves false.
 */
export async function tryReconcileAuthBindings(
  binder: Pick<RuntimeAuthBinder, 'reconcileBindings'>,
  store: Pick<StateStore, 'loadFleet'>,
  targets: ReadonlyMap<string, ExecutionTarget>,
  log: (line: string) => void,
): Promise<boolean> {
  try {
    const fleet = await store.loadFleet();

    const listed = new Set(fleet.map((entry) => entry.hostKey ?? entry.sessionID));

    await binder.reconcileBindings(
      (target) => targets.get(target)?.provider?.brokerAuth ?? null,
      listed,
      log,
    );
  } catch (error) {
    log(
      `atc could not settle runtime auth bindings (${error instanceof Error ? error.message : String(error)})`,
    );

    return false;
  }

  return true;
}
