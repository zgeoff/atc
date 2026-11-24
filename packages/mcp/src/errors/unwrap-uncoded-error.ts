import { findCodedError } from './find-coded-error';

// The router reports a caller error that holds no code as internal, and a tool result shows that
// error as its plain message.
export function unwrapUncodedError(error: unknown): unknown {
  if (
    findCodedError(error)?.code === 'internal' &&
    error instanceof Error &&
    error.cause instanceof Error &&
    findCodedError(error.cause) === null
  ) {
    return error.cause;
  }

  return error;
}
