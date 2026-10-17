import type { RuntimeAuthBinding, RuntimeAuthBindingState } from '@atc/store';
import { match } from 'ts-pattern';

export function planLaunchAdmission(
  row: Readonly<RuntimeAuthBinding> | null,
  attemptID: string | null,
): 'admit' | 'blocked' {
  if (row === null) {
    return 'blocked';
  }

  return match<RuntimeAuthBindingState, 'admit' | 'blocked'>(row.state)
    .with('ready', () => 'admit')
    .with('provisioning', () =>
      attemptID !== null && row.attemptID === attemptID && row.rebind === null
        ? 'admit'
        : 'blocked',
    )
    .with('revoked', 'revocation_pending', 'rollback_pending', 'rebind_failed', () => 'blocked')
    .exhaustive();
}
