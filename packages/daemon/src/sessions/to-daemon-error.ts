import { DaemonError } from '@atc/protocol/wire';
import { StaleOwnershipError } from '@atc/store';

export function toDaemonError(error: unknown): unknown {
  return error instanceof StaleOwnershipError
    ? new DaemonError('stale_epoch', error.message)
    : error;
}
