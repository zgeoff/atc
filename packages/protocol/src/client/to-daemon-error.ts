import { isRecord } from '@atc/core';
import { ORPCError } from '@orpc/client';
import { DaemonError } from '../wire/daemon-error';
import { ERROR_CODES } from '../wire/protocol';

// The daemon's own error for one a peer call failed with: a refusal keeps
// its code, message and data, and any other failure is internal.
export function toDaemonError(error: unknown): DaemonError {
  if (error instanceof DaemonError) {
    return error;
  }

  if (error instanceof ORPCError) {
    const raw: unknown = error.code;
    const code = ERROR_CODES.find((known) => known === raw) ?? 'internal';
    const data: unknown = error.data;
    const detail = isRecord(data) ? data : undefined;

    return new DaemonError(code, error.message, detail);
  }

  const message = error instanceof Error ? error.message : String(error);

  return new DaemonError('internal', message);
}
