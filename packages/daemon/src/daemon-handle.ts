export interface DaemonHandle {
  // A second stop, or a disposal after one, waits on the first and stops
  // nothing again.
  readonly stop: () => Promise<void>;

  readonly [Symbol.asyncDispose]: () => Promise<void>;

  // How many client-protocol connections are open right now.
  readonly countClients: () => number;

  // How many event reads are waiting right now for the trail to grow.
  readonly countEventWaiters: () => number;

  // The port the TCP listener bound, or null without one.
  readonly listenPort: number | null;

  // Reads the token file again and closes every TCP connection whose
  // handshake token it no longer holds. A file that fails to load drops
  // every token and closes every TCP connection until a load succeeds.
  readonly refreshTokens: () => void;
}
