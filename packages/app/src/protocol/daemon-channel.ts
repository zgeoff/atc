/**
 * One open protocol connection to a daemon, as a caller that does not own
 * the transport drives it: the handshake, correlated requests, a callback
 * for when the connection ends, and closing it.
 */
export interface DaemonChannel {
  onClose: () => void;
  readonly sendHello: (build: string) => Promise<Readonly<Record<string, unknown>>>;

  // A request with a principal acts as that principal.
  readonly sendRequest: (
    m: string,
    p?: Readonly<Record<string, unknown>>,
    as?: string,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly stop: () => void;
}
