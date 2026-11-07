import { createStateStore } from '@atc/store';
import { collectCompletedIdempotencyKeys } from './collect-completed-idempotency-keys';

// Completes each completed key in a daemon's state database again with no
// target, as a key completed before the ledger recorded targets reads.
export async function removeIdempotencyKeyTargets(dbPath: string): Promise<void> {
  const store = await createStateStore(dbPath);

  try {
    const records = await store.readIdempotencyKeys();

    for (const key of collectCompletedIdempotencyKeys(records)) {
      await store.updateIdempotencyCompleted(key, key.result, key.updatedAt, null);
    }
  } finally {
    await store.stop();
  }
}
