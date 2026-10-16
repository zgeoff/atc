import type { RuntimeAuthBinding, RuntimeAuthBindingState } from '@atc/store';
import { match } from 'ts-pattern';

// What a starting daemon does with one stored binding, from the binding and
// whether a fleet entry lists its host and its target's broker is here.
interface ReconcileFacts {
  readonly isOrphan: boolean;
  readonly hasHost: boolean;
}

/**
 * What a starting daemon does with a binding a stopped daemon may have
 * left mid-change: a rebind in flight, or one that failed, is settled as a
 * failed rebind; a spawn attempt no fleet entry lists, still provisioning
 * or pending its rollback, is taken back through its target's broker. Any
 * other binding is kept as it is.
 */
export function planBindingReconcile(
  row: Readonly<RuntimeAuthBinding>,
  facts: ReconcileFacts,
): 'settle_rebind' | 'remove_attempt' | 'keep' {
  const removable = facts.isOrphan && facts.hasHost;

  return match<RuntimeAuthBindingState, 'settle_rebind' | 'remove_attempt' | 'keep'>(row.state)
    .with('provisioning', () => {
      if (row.rebind !== null) {
        return 'settle_rebind';
      }

      return removable ? 'remove_attempt' : 'keep';
    })
    .with('rebind_failed', () => (row.rebind === null ? 'keep' : 'settle_rebind'))
    .with('rollback_pending', () => (removable ? 'remove_attempt' : 'keep'))
    .with('ready', 'revoked', 'revocation_pending', () => 'keep')
    .exhaustive();
}
