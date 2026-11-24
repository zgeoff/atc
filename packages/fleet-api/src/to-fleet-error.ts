import { isRecord } from '@atc/core';
import { ORPCError } from '@orpc/server';
import { buildFleetError } from './build-fleet-error';

// An error from the caller, as the oRPC error every front door reads. It keeps its code, message
// and data, whether it is an AtcError, the gateway's own error, a client error or a plain object,
// because only its code property tells them apart. An error with no code is internal.
export function toFleetError(error: unknown): ORPCError<string, unknown> {
  if (error instanceof ORPCError) {
    const rawCode: unknown = error.code;
    const data: unknown = error.data;
    const code = typeof rawCode === 'string' ? rawCode : 'internal';

    return buildFleetError(code, {
      message: error.message,
      data,
      cause: error,
    });
  }

  const code = isRecord(error) ? error['code'] : undefined;

  if (isRecord(error) && typeof code === 'string' && code !== '') {
    const message = error['message'];

    return buildFleetError(code, {
      message: typeof message === 'string' ? message : code,
      data: error['data'],
      cause: error,
    });
  }

  return buildFleetError('internal', {
    message: toMessage(error),
    cause: error,
  });
}

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (isRecord(error) && typeof error['message'] === 'string') {
    return error['message'];
  }

  return typeof error === 'string' ? error : 'the caller failed with no message';
}
