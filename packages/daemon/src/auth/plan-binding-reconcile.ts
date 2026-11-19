import type { RuntimeAuthBinding, RuntimeAuthBindingState } from '@atc/store';
import { match } from 'ts-pattern';

interface ReconcileFacts {
  readonly isOrphan: boolean;
  readonly hasHost: boolean;
}

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
