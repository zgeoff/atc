import type { IdempotencyRecord } from '../idempotency-record';

type CompletedIdempotencyRecord = IdempotencyRecord & { readonly result: string };

export function collectCompletedIdempotencyRecords(
  records: readonly IdempotencyRecord[],
): CompletedIdempotencyRecord[] {
  return records.filter(
    (record): record is CompletedIdempotencyRecord =>
      record.state === 'completed' && record.result !== null,
  );
}
