/**
 * A call impd refused or could not serve, with impd's error code (`LEASED`,
 * `NOT_FOUND`, `FORBIDDEN`, and the rest) and the data that code defines.
 * A transport failure carries `UNREACHABLE` or `UNAUTHORIZED`.
 */
export class ImpPortError extends Error {
  readonly code: string;

  readonly data: unknown;

  constructor(code: string, message: string, data?: unknown) {
    super(message);

    this.code = code;
    this.data = data;
    this.name = 'ImpPortError';
  }
}
