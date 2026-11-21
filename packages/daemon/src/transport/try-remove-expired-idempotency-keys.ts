import type { StateStore } from '@atc/store';
import type { Clock } from '@zgeoff/std';

export async function tryRemoveExpiredIdempotencyKeys(
  store: Pick<StateStore, 'removeExpiredIdempotencyKeys'>,
  clock: Pick<Clock, 'now' | 'schedule'>,
  retentionMs: number,
): Promise<boolean> {
  try {
    await store.removeExpiredIdempotencyKeys(clock.now() - retentionMs);
  } catch {
    return false;
  }

  return true;
}
