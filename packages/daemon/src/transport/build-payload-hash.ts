import { createHash } from 'node:crypto';
import { sortJSONKeys } from '@atc/core';

/**
 * The SHA-256 of a request's params as canonical JSON: object keys sorted
 * by UTF-16 code unit at every depth, with the idempotency key and the
 * replay-only flag left out. Two requests that differ only in key order, in
 * their idempotency key, or in whether they only replay hash the same.
 */
export function buildPayloadHash(params: Readonly<Record<string, unknown>>): string {
  const { idempotencyKey: _ignored, replayOnly: _replayOnly, ...payload } = params;

  return createHash('sha256')
    .update(JSON.stringify(sortJSONKeys(payload, 'code-unit')))
    .digest('hex');
}
