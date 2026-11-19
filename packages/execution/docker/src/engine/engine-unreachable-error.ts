// The Engine did not answer at its socket.
export class EngineUnreachableError extends Error {
  readonly socket: string;

  constructor(socket: string, options?: Readonly<ErrorOptions>) {
    super(`the Docker Engine does not answer at ${socket}`, options);

    this.name = 'EngineUnreachableError';
    this.socket = socket;
  }
}
