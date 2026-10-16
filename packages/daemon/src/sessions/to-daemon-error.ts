import { DaemonError } from '@atc/protocol/wire';
import { StaleOwnershipError } from '@atc/store';

/**
 * The protocol error a store failure answers with: a write refused for stale
 * ownership becomes `stale_epoch` with the store's message. Any other error
 * comes back unchanged.
 */
export function toDaemonError(error: unknown): unknown {
  return error instanceof StaleOwnershipError
    ? new DaemonError('stale_epoch', error.message)
    : error;
}
