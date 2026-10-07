interface StubUnansweringListener {
  readonly port: number;

  // What each read took from any connection, decoded, in arrival order.
  readonly received: readonly string[];

  readonly [Symbol.dispose]: () => void;
}

/**
 * A stand-in for a daemon that accepts a connection and never answers it:
 * on a loopback port, it records what each read takes from a connection,
 * sends nothing back, and keeps the connection open. Disposal stops it and
 * drops every connection it holds; hold the result with `using`.
 */
export function startStubUnansweringListener(): StubUnansweringListener {
  const received: string[] = [];

  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(_socket, data) {
        received.push(data.toString());
      },
    },
  });

  return {
    port: server.port,
    received,
    [Symbol.dispose]: () => {
      server.stop(true);
    },
  };
}
