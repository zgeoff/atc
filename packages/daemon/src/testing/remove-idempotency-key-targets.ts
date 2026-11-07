import { createStateStore } from '@atc/store';

// Completes each completed key in a daemon's state database again with no
// target, as a key completed before the ledger recorded targets reads.
export async function removeIdempotencyKeyTargets(dbPath: string): Promise<void> {
  const store = await createStateStore(dbPath);

  try {
    for (const record of await store.readIdempotencyKeys()) {
      if (record.state === 'completed' && record.result !== null) {
        await store.updateIdempotencyCompleted(record, record.result, record.updatedAt, null);
      }
    }
  } finally {
    await store.stop();
  }
}
