import type { StateStore } from '@atc/store';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import type { RuntimeAuthBinder } from './runtime-auth-binder';

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
