import { AtcError, ERROR_CODES } from '@atcx/contract/light';
import { ORPCError } from '@orpc/client';

export interface ProcedureTraits {
  readonly readOnly: boolean;
  readonly keyed: boolean;
}

// Turns whatever a call rejected with into an AtcError. A lost connection gets the facts a caller
// needs to decide on a resend: whether the procedure is safe to resend, and whether a resend under
// the same idempotency key replays the first answer.
export function toAtcError(
  error: unknown,
  procedure: string,
  traits: ProcedureTraits | undefined,
): AtcError {
  if (error instanceof AtcError) {
    if (error.code !== 'connection_lost') {
      return error;
    }

    return new AtcError('connection_lost', error.message, {
      procedure,
      readOnly: traits?.readOnly ?? false,
      keyed: traits?.keyed ?? false,
    });
  }

  if (error instanceof ORPCError) {
    const raw: unknown = error.code;
    const code = ERROR_CODES.find((known) => known === raw) ?? 'internal';
    const data: unknown = error.data;
    const detail = typeof data === 'object' && data !== null ? Object.entries(data) : [];

    return new AtcError(code, error.message, Object.fromEntries(detail));
  }

  const message = error instanceof Error ? error.message : String(error);

  return new AtcError('internal', message);
}
