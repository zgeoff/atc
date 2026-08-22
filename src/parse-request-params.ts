import type { z } from 'zod';
import { isRecord } from './report';
import { REQUEST_PARAM_SCHEMAS } from './request-param-schemas';

export type RequestMethod = keyof typeof REQUEST_PARAM_SCHEMAS;

type RequestParams<M extends RequestMethod> = z.infer<(typeof REQUEST_PARAM_SCHEMAS)[M]>;

export type ParsedRequestParams<M extends RequestMethod> =
  | { readonly ok: true; readonly data: RequestParams<M> }
  | { readonly ok: false; readonly message: string };

/**
 * Validates and defaults one request's params against its method's schema.
 * A malformed shape folds into a single message the caller reports as
 * bad_args, instead of a thrown ZodError.
 */
export function parseRequestParams<M extends RequestMethod>(
  method: M,
  rawParams: unknown,
): ParsedRequestParams<M> {
  const input = isRecord(rawParams) ? rawParams : {};
  const result = REQUEST_PARAM_SCHEMAS[method].safeParse(input);

  if (!result.success) {
    return { ok: false, message: result.error.issues[0]?.message ?? 'invalid params' };
  }

  // oxlint-disable-next-line no-unsafe-type-assertion -- method narrows M, but TS can't follow that through an indexed lookup into the schema map; a successful safeParse against that same lookup guarantees the shape at runtime
  return { ok: true, data: result.data as RequestParams<M> };
}
