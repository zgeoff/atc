import { createHash } from 'node:crypto';
import { sortJSONKeys } from '@atc/core';

/**
 * The SHA-256 of a keyed request's params as canonical JSON: object keys
 * sorted by UTF-16 code unit at every depth, with the idempotency key and
 * the replay-only flag left out, so a retry that differs only in key order
 * or in whether it only replays hashes the same and one with another
 * payload does not.
 */
export function buildBindingPayloadHash(params: Readonly<Record<string, unknown>>): string {
  const { idempotencyKey: _ignored, replayOnly: _replayOnly, ...payload } = params;

  return createHash('sha256')
    .update(JSON.stringify(sortJSONKeys(payload, 'code-unit')))
    .digest('hex');
}
