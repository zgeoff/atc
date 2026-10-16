import type { Clock } from '@atc/core';
import type { StateStore } from '@atc/store';

/**
 * Removes the idempotency keys older than the retention. A sweep that
 * fails leaves the keys for the next one and resolves false.
 */
export async function tryRemoveExpiredIdempotencyKeys(
  store: Pick<StateStore, 'removeExpiredIdempotencyKeys'>,
  clock: Clock,
  retentionMs: number,
): Promise<boolean> {
  try {
    await store.removeExpiredIdempotencyKeys(clock.now() - retentionMs);
  } catch {
    return false;
  }

  return true;
}
