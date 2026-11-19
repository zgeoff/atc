// The Engine answered with a status the call does not expect.
export class EngineError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);

    this.name = 'EngineError';
    this.status = status;
  }
}
