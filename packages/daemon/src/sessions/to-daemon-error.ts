import { StaleOwnershipError } from '@atc/store';
import { DaemonError } from '@atcx/contract/client';

export function toDaemonError(error: unknown): unknown {
  return error instanceof StaleOwnershipError
    ? new DaemonError('stale_epoch', error.message)
    : error;
}
