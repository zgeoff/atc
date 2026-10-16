import { expect, mock, test } from 'bun:test';
import { buildStubClock } from '@atc/test-utils';
import { tryRemoveExpiredIdempotencyKeys } from './try-remove-expired-idempotency-keys';

test('it removes the keys older than the retention', async () => {
  const removeExpiredIdempotencyKeys = mock<(before: number) => Promise<void>>(() =>
    Promise.resolve(),
  );

  const removed = await tryRemoveExpiredIdempotencyKeys(
    { removeExpiredIdempotencyKeys },
    buildStubClock(1_000_000),
    60_000,
  );

  expect(removed).toBeTrue();
  expect(removeExpiredIdempotencyKeys).toHaveBeenCalledExactlyOnceWith(940_000);
});

test('it leaves the keys for the next sweep when one fails', async () => {
  const removed = await tryRemoveExpiredIdempotencyKeys(
    { removeExpiredIdempotencyKeys: () => Promise.reject(new Error('database is locked')) },
    buildStubClock(1_000_000),
    60_000,
  );

  expect(removed).toBeFalse();
});
