interface StubClosingListener {
  readonly [Symbol.dispose]: () => void;
}

/**
 * A stand-in for a daemon that hangs up: it listens on the unix socket path
 * and ends every connection as soon as it opens, reading nothing. Disposal
 * stops it; hold the result with `using`.
 */
export function startStubClosingListener(path: string): StubClosingListener {
  const server = Bun.listen({
    unix: path,
    socket: {
      open(socket) {
        socket.end();
      },
      data() {},
    },
  });

  return {
    [Symbol.dispose]: () => {
      server.stop(true);
    },
  };
}
