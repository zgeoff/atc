import { isRecord } from '@atc/core';
import { AtcError, ERROR_CODES } from '@atcx/contract/light';
import { ORPCError } from '@orpc/client';

export function toRawAtcError(error: unknown): AtcError {
  if (error instanceof AtcError) {
    return error;
  }

  if (error instanceof ORPCError) {
    const raw: unknown = error.code;
    const code = ERROR_CODES.find((known) => known === raw) ?? 'internal';
    const data: unknown = error.data;
    const detail = isRecord(data) ? data : undefined;

    return new AtcError(code, error.message, detail);
  }

  const message = error instanceof Error ? error.message : String(error);

  return new AtcError('internal', message);
}
