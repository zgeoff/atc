import type { RuntimeAuthBinding, RuntimeAuthBindingState } from '@atc/store';
import { match } from 'ts-pattern';

/**
 * Whether a rebind may move a host's binding to a new revision: a ready,
 * revoked or failed-rebind binding may move, and so may one whose spawn
 * provisioned its imp but never recorded its start. A binding still
 * settling a revoke or a rollback, or one a rebind still provisions,
 * blocks it.
 */
export function planRebindStart(row: Readonly<RuntimeAuthBinding>): 'rebind' | 'blocked' {
  return match<RuntimeAuthBindingState, 'rebind' | 'blocked'>(row.state)
    .with('ready', 'revoked', 'rebind_failed', () => 'rebind')
    .with('provisioning', () => (row.rebind === null && row.impID !== null ? 'rebind' : 'blocked'))
    .with('revocation_pending', 'rollback_pending', () => 'blocked')
    .exhaustive();
}
