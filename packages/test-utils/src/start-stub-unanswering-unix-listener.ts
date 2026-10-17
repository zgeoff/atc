import { registerTestCleanup } from './register-test-cleanup';

interface StubUnansweringUnixListener {
  // What each read took from any connection, decoded, in arrival order.
  readonly received: readonly string[];

  readonly stop: () => void;
}

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
