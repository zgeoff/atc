export class AppServerError extends Error {
  // -1 when the connection closed or never opened before an answer came
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);

    this.name = 'AppServerError';
    this.code = code;
  }
}
