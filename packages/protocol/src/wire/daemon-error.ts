import type { ErrorCode } from './protocol';

export class DaemonError extends Error {
  readonly code: ErrorCode;

  // Structured detail the error code defines for itself, sent as `err.data`.
  readonly data: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message: string, data?: Readonly<Record<string, unknown>>) {
    super(message);

    this.code = code;
    this.data = data;
    this.name = 'DaemonError';
  }
}
