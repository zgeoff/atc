import { isRecord } from '@atc/core';
import { ORPCError, ValidationError } from '@orpc/server';

// An error from the caller or from input validation, as the oRPC error every front door reads. A
// caller's error keeps its code, message and data, whether it is an AtcError, the gateway's own
// error or a client error, because only its code property tells them apart.
export function toFleetError(error: unknown): ORPCError<string, unknown> {
  if (error instanceof ORPCError) {
    return error.code === 'BAD_REQUEST' && error.cause instanceof ValidationError
      ? new ORPCError('bad_args', {
          message: error.cause.issues[0]?.message ?? 'invalid params',
          cause: error,
        })
      : error;
  }

  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    const data = 'data' in error && isRecord(error.data) ? error.data : undefined;

    return new ORPCError(error.code, { message: error.message, data, cause: error });
  }

  return new ORPCError('internal', {
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}
