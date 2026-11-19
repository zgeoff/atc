export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);

    this.name = 'DaemonUnavailableError';
  }
}
