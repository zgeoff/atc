import type { RuntimeAuthBinding, RuntimeAuthBindingState } from '@atc/store';
import { match } from 'ts-pattern';

/**
 * Whether a harness start or attach on a host may go out: a ready binding
 * admits it, and so does one the launching spawn attempt still provisions
 * with no rebind in flight. Every other binding, and a host with none,
 * blocks it.
 */
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
