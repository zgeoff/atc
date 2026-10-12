import { registerTestCleanup } from './register-test-cleanup';

interface StubRefusingListener {
  readonly port: number;

  // What each read took from any connection, decoded, in arrival order.
  readonly received: readonly string[];

  readonly stop: () => void;
}

/**
 * A stand-in for a daemon's TCP listener refusing a connection whose first
 * line is not a handshake: on a loopback port, it records what each read
 * takes from a connection and ends that connection, answering nothing.
 * It stops once the current test finishes, so it must run inside a test;
 * `stop` stops it sooner, and a second stop does nothing.
 */
export function startStubRefusingListener(): StubRefusingListener {
  const received: string[] = [];

  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, data) {
        received.push(data.toString());
        socket.end();
      },
      error() {},
    },
  });

  const stop = registerTestCleanup(() => {
    server.stop(true);
  });

  return {
    port: server.port,
    received,
    stop,
  };
}
