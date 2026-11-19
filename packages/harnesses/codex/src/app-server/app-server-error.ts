export class AppServerError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);

    this.name = 'AppServerError';
    this.code = code;
  }
}
