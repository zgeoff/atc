import type { Clock } from '@atc/core';
import type { StateStore } from '@atc/store';

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
