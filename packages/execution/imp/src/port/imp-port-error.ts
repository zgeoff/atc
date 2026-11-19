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
