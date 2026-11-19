import { createStateStore } from '../stores/create-state-store';

export interface IdempotencySeedDeps {
  readonly dbPath: string;
}

export async function seedSweptIdempotencyKeys(deps: IdempotencySeedDeps): Promise<void> {
  const store = await createStateStore(deps.dbPath);

  try {
    await store.removeExpiredIdempotencyKeys(Number.MAX_SAFE_INTEGER);
  } finally {
    await store.stop();
  }
}
