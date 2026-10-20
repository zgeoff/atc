export interface HelloOptions {
  // the bearer token a TCP listener requires
  readonly token?: string;

  // the atc session the client runs inside, if any
  readonly session?: string | undefined;

  // the principal the connection acts as, which a TCP listener's config
  // must list
  readonly principal?: string;
}

export interface DaemonChannel {
  onClose: () => void;
  readonly sendHello: (
    build: string,
    options?: HelloOptions,
  ) => Promise<Readonly<Record<string, unknown>>>;

  // A request with a principal acts as that principal, and carries its
  // name when one is given.
  readonly sendRequest: (
    method: string,
    params?: Readonly<Record<string, unknown>>,
    as?: string,
    asName?: string,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly stop: () => void;
}
