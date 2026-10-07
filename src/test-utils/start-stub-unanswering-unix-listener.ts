interface StubUnansweringUnixListener {
  // What each read took from any connection, decoded, in arrival order.
  readonly received: readonly string[];

  readonly [Symbol.dispose]: () => void;
}

/**
 * A stand-in for a daemon socket that takes a connection and never answers
 * it: it listens on the unix socket path, records what each read takes from
 * a connection, sends nothing back, and keeps the connection open. Disposal
 * stops it and drops every connection it holds; hold the result with
 * `using`.
 */
export function startStubUnansweringUnixListener(path: string): StubUnansweringUnixListener {
  const received: string[] = [];

  const server = Bun.listen({
    unix: path,
    socket: {
      data(_socket, data) {
        received.push(data.toString());
      },
    },
  });

  return {
    received,
    [Symbol.dispose]: () => {
      server.stop(true);
    },
  };
}
