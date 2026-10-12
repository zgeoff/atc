import { createHash } from 'node:crypto';

/**
 * The SHA-256 of a keyed request's params as canonical JSON: object keys
 * sorted by UTF-16 code unit at every depth, with the idempotency key and
 * the replay-only flag left out, so a retry that differs only in key order
 * or in whether it only replays hashes the same and one with another
 * payload does not. Code-unit order never ties
 * two distinct keys, as a locale comparison can for two spellings of one
 * accented letter.
 */
export function buildBindingPayloadHash(params: Readonly<Record<string, unknown>>): string {
  const { idempotencyKey: _ignored, replayOnly: _replayOnly, ...payload } = params;

  return createHash('sha256')
    .update(JSON.stringify(sortKeysByCodeUnit(payload)))
    .digest('hex');
}

function sortKeysByCodeUnit(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysByCodeUnit(item));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => Number(a > b) - Number(a < b))
        .map(([key, item]) => [key, sortKeysByCodeUnit(item)]),
    );
  }

  return value;
}
