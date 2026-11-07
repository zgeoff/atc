import { createStateStore } from '../create-state-store';

export interface IdempotencySeedDeps {
  readonly dbPath: string;
}

// Drops every completed key in a daemon's state database, as the daemon's
// sweep does once each key's retention has passed.
export async function seedSweptIdempotencyKeys(deps: IdempotencySeedDeps): Promise<void> {
  const store = await createStateStore(deps.dbPath);

  try {
    await store.removeExpiredIdempotencyKeys(Number.MAX_SAFE_INTEGER);
  } finally {
    await store.stop();
  }
}
