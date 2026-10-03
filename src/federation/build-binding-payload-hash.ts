import { createHash } from 'node:crypto';
import { sortJSONKeys } from '../shared/sort-json-keys';

/**
 * The SHA-256 of a keyed request's params as canonical JSON: object keys
 * sorted at every depth, with the idempotency key itself left out, so a
 * retry that differs only in key order hashes the same and one with
 * another payload does not.
 */
export function buildBindingPayloadHash(params: Readonly<Record<string, unknown>>): string {
  const { idempotencyKey: _ignored, ...payload } = params;

  return createHash('sha256')
    .update(JSON.stringify(sortJSONKeys(payload)))
    .digest('hex');
}
