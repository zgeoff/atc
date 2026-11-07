import { createStateStore } from '@atc/store';

// Drops every completed key in a daemon's state database, as the daemon's
// sweep does once each key's retention has passed.
export async function removeCompletedIdempotencyKeys(dbPath: string): Promise<void> {
  const store = await createStateStore(dbPath);

  try {
    await store.removeExpiredIdempotencyKeys(Number.MAX_SAFE_INTEGER);
  } finally {
    await store.stop();
  }
}
