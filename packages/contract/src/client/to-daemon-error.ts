import { ORPCError } from '@orpc/client';
import { z } from 'zod';
import { ERROR_CODES } from '../light/error-codes';
import { DaemonError } from './daemon-error';

const RECORD_SCHEMA = z.record(z.string(), z.unknown());

// The daemon's own error for one a peer call failed with: a refusal keeps
// its code, message and data, and any other failure is internal.
export function toDaemonError(error: unknown): DaemonError {
  if (error instanceof DaemonError) {
    return error;
  }

  if (error instanceof ORPCError) {
    const raw: unknown = error.code;
    const code = ERROR_CODES.find((known) => known === raw) ?? 'internal';
    const record = RECORD_SCHEMA.safeParse(error.data);
    const detail = record.success ? record.data : undefined;

    return new DaemonError(code, error.message, detail);
  }

  const message = error instanceof Error ? error.message : String(error);

  return new DaemonError('internal', message);
}
