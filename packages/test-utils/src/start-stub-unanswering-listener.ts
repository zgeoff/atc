import { registerTestCleanup } from './register-test-cleanup';

interface StubUnansweringListener {
  readonly port: number;

  // What each read took from any connection, decoded, in arrival order.
  readonly received: readonly string[];

  readonly stop: () => void;
}

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
    stop,
  };
}
