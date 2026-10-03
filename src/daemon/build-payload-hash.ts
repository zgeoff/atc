import { createHash } from 'node:crypto';
import { isRecord } from '../shared/report';

/**
 * The SHA-256 of a request's params as canonical JSON: object keys sorted
 * at every depth, with the idempotency key and the replay-only flag left
 * out. Two requests that differ only in key order, in their idempotency
 * key, or in whether they only replay hash the same.
 */
export function buildPayloadHash(params: Readonly<Record<string, unknown>>): string {
  const { idempotencyKey: _ignored, replayOnly: _replayOnly, ...payload } = params;

  return createHash('sha256')
    .update(JSON.stringify(sortKeys(payload)))
    .digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeys(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sortKeys(value[key])]),
  );
}
