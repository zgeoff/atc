import { registerTestCleanup } from './register-test-cleanup';

interface StubUnansweringListener {
  readonly port: number;

  // What each read took from any connection, decoded, in arrival order.
  readonly received: readonly string[];

  readonly [Symbol.dispose]: () => void;
}

/**
 * A stand-in for a daemon that accepts a connection and never answers it:
 * on a loopback port, it records what each read takes from a connection,
 * sends nothing back, and keeps the connection open. It stops, dropping
 * every connection it holds, once the current test finishes, so it must run
 * inside a test; disposal stops it sooner, and a second stop does nothing.
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

  const stop = registerTestCleanup(() => {
    server.stop(true);
  });

  return {
    port: server.port,
    received,
    [Symbol.dispose]: stop,
  };
}
