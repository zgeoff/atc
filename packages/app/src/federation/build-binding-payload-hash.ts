import { createHash } from 'node:crypto';
import { sortJSONKeys } from '@atc/core';

export function buildBindingPayloadHash(params: Readonly<Record<string, unknown>>): string {
  const { idempotencyKey: _ignored, replayOnly: _replayOnly, ...payload } = params;

  return createHash('sha256')
    .update(JSON.stringify(sortJSONKeys(payload, 'code-unit')))
    .digest('hex');
}
