import type { RuntimeAuthBinding, RuntimeAuthBindingState } from '@atc/store';
import { match } from 'ts-pattern';

/**
 * How a launch on a bound host checks its binding: a ready binding is
 * verified, and a ready or failed-rebind binding whose auth selection
 * changed moves to the new selection when the launch's target rebinds a
 * changed one. Every other binding blocks the launch.
 */
export function planBindingVerify(
  row: Readonly<RuntimeAuthBinding>,
  isChanged: boolean,
  canRebind: boolean,
): 'verify' | 'rebind' | 'blocked' {
  const isRebindable = canRebind && isChanged;

  return match<RuntimeAuthBindingState, 'verify' | 'rebind' | 'blocked'>(row.state)
    .with('ready', () => (isRebindable ? 'rebind' : 'verify'))
    .with('rebind_failed', () => (isRebindable ? 'rebind' : 'blocked'))
    .with('provisioning', 'revoked', 'revocation_pending', 'rollback_pending', () => 'blocked')
    .exhaustive();
}
