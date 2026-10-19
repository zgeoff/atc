import type { RuntimeAuthBinding, RuntimeAuthBindingState } from '@atc/store';
import { match } from 'ts-pattern';

export function planRebindStart(row: Readonly<RuntimeAuthBinding>): 'rebind' | 'blocked' {
  // a provisioning binding may rebind once its spawn recorded the host, though not its start
  return match<RuntimeAuthBindingState, 'rebind' | 'blocked'>(row.state)
    .with('ready', 'revoked', 'rebind_failed', () => 'rebind')
    .with('provisioning', () => (row.rebind === null && row.hostID !== null ? 'rebind' : 'blocked'))
    .with('revocation_pending', 'rollback_pending', () => 'blocked')
    .exhaustive();
}
