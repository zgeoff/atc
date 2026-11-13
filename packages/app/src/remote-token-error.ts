// The daemon's token could not be read, so the boot never reached the daemon.
export class RemoteTokenError extends Error {
  constructor(message: string, options?: Readonly<ErrorOptions>) {
    super(message, options);

    this.name = 'RemoteTokenError';
  }
}
