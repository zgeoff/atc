import type { ErrorCode } from './protocol';

/**
 * A protocol-level error answer from the daemon, thrown to reject the
 * request that caused it.
 */
export class DaemonError extends Error {
  readonly code: ErrorCode;

  // Structured detail the error code defines for itself, sent as `err.data`.
  readonly data: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, msg: string, data?: Readonly<Record<string, unknown>>) {
    super(msg);

    this.code = code;
    this.data = data;
    this.name = 'DaemonError';
  }
}
