import { createStateStore } from '../create-state-store';
import { collectCompletedIdempotencyRecords } from './collect-completed-idempotency-records';
import type { IdempotencySeedDeps } from './seed-swept-idempotency-keys';

// Completes each completed key in a daemon's state database again with no
// target, as a key completed before the ledger recorded targets reads.
export async function seedTargetlessCompletedIdempotencyKeys(
  deps: IdempotencySeedDeps,
): Promise<void> {
  const store = await createStateStore(deps.dbPath);

  try {
    const records = await store.readIdempotencyKeys();

    for (const record of collectCompletedIdempotencyRecords(records)) {
      await store.updateIdempotencyCompleted(record, record.result, record.updatedAt, null);
    }
  } finally {
    await store.stop();
  }
}
