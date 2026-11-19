import { createStateStore } from '../stores/create-state-store';
import { collectCompletedIdempotencyRecords } from './collect-completed-idempotency-records';
import type { IdempotencySeedDeps } from './seed-swept-idempotency-keys';

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
