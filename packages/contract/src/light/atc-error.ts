import type { ErrorCode } from './error-codes';

// The error every atc caller throws and matches, for a daemon's refusal and for a connection that
// the client could not open or lost.
export class AtcError extends Error {
  readonly code: ErrorCode;

  readonly data: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, data: Readonly<Record<string, unknown>> = {}) {
    super(message);

    this.code = code;
    this.data = data;
    this.name = 'AtcError';
  }
}
