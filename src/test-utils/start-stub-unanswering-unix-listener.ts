import { registerTestCleanup } from './register-test-cleanup';

interface StubUnansweringUnixListener {
  // What each read took from any connection, decoded, in arrival order.
  readonly received: readonly string[];

  readonly stop: () => void;
}

/**
 * A stand-in for a daemon socket that takes a connection and never answers
 * it: it listens on the unix socket path, records what each read takes from
 * a connection, sends nothing back, and keeps the connection open. It
 * stops, dropping every connection it holds, once the current test
 * finishes, so it must run inside a test; `stop` stops it sooner, and a
 * second stop does nothing.
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

  const stop = registerTestCleanup(() => {
    server.stop(true);
  });

  return {
    received,
    stop,
  };
}
