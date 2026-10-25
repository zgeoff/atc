import { isRecord } from '@atc/core';
import { REQUEST_PARAM_SCHEMAS } from '@atcx/contract';
import type { z } from 'zod';

export type RequestMethod = keyof typeof REQUEST_PARAM_SCHEMAS;

export type RequestParams<M extends RequestMethod> = z.infer<(typeof REQUEST_PARAM_SCHEMAS)[M]>;

export type ParsedRequestParams<M extends RequestMethod> =
  | { readonly ok: true; readonly data: RequestParams<M> }
  | { readonly ok: false; readonly message: string };

// typed as a mapped type, so an indexed lookup with a generic method keeps the
// method's own params type, which TypeScript loses on the schema object's type
const TYPED_REQUEST_PARAM_SCHEMAS: {
  readonly [K in RequestMethod]: z.ZodType<RequestParams<K>>;
} = REQUEST_PARAM_SCHEMAS;

export function parseRequestParams<M extends RequestMethod>(
  method: M,
  rawParams: unknown,
): ParsedRequestParams<M> {
  const input = isRecord(rawParams) ? rawParams : {};
  const result = TYPED_REQUEST_PARAM_SCHEMAS[method].safeParse(input);

  if (!result.success) {
    return { ok: false, message: result.error.issues[0]?.message ?? 'invalid params' };
  }

  return { ok: true, data: result.data };
}
