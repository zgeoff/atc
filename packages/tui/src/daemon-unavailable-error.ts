// A request that never left, because the daemon's link is not up. It never falls back to another
// daemon.
export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);

    this.name = 'DaemonUnavailableError';
  }
}
