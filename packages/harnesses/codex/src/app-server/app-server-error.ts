/**
 * A JSON-RPC request to a Codex App Server that failed: the error the
 * server answered, with its code, or a code of -1 for a connection that
 * closed or never opened before an answer came.
 */
export class AppServerError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);

    this.name = 'AppServerError';
    this.code = code;
  }
}
