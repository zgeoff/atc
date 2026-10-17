import { registerTestCleanup } from './register-test-cleanup';

interface StubRefusingListener {
  readonly port: number;

  // What each read took from any connection, decoded, in arrival order.
  readonly received: readonly string[];

  readonly stop: () => void;
}

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
