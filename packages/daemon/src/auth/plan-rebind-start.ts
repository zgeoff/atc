import type { RuntimeAuthBinding, RuntimeAuthBindingState } from '@atc/store';
import { match } from 'ts-pattern';

export function planRebindStart(row: Readonly<RuntimeAuthBinding>): 'rebind' | 'blocked' {
  return match<RuntimeAuthBindingState, 'rebind' | 'blocked'>(row.state)
    .with('ready', 'revoked', 'rebind_failed', () => 'rebind')
    .with('provisioning', () => (row.rebind === null && row.hostID !== null ? 'rebind' : 'blocked'))
    .with('revocation_pending', 'rollback_pending', () => 'blocked')
    .exhaustive();
}
