import type { RuntimeAuthBinding, RuntimeAuthBindingState } from '@atc/store';
import { match } from 'ts-pattern';

export function planReadyUpdate(
  row: Readonly<RuntimeAuthBinding> | null,
  attemptID: string,
): 'ready' | 'keep' {
  if (row === null) {
    return 'keep';
  }

  return match<RuntimeAuthBindingState, 'ready' | 'keep'>(row.state)
    .with('provisioning', () =>
      row.attemptID === attemptID && row.rebind === null ? 'ready' : 'keep',
    )
    .with(
      'ready',
      'revoked',
      'revocation_pending',
      'rollback_pending',
      'rebind_failed',
      () => 'keep',
    )
    .exhaustive();
}
