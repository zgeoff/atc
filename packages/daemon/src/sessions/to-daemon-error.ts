import { StaleOwnershipError } from '@atc/store';
import { AtcError } from '@atcx/contract/light';

export function toDaemonError(error: unknown): unknown {
  return error instanceof StaleOwnershipError ? new AtcError('stale_epoch', error.message) : error;
}
