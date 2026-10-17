import type { RuntimeAuthBinding, RuntimeAuthBindingState } from '@atc/store';
import { match } from 'ts-pattern';

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
