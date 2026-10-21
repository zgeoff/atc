import { buildPayloadHash } from './build-payload-hash';
import type { KeyedRequest } from './create-idempotency-ledger';

export function buildKeyedRequest(
  params: Readonly<Record<string, unknown>> & {
    readonly idempotencyKey?: string | undefined;
    readonly replayOnly?: boolean | undefined;
  },
): KeyedRequest | null {
  return params.idempotencyKey === undefined
    ? null
    : {
        key: params.idempotencyKey,
        payloadHash: buildPayloadHash(params),
        replayOnly: params.replayOnly === true,
      };
}
