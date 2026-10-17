import { registerTestCleanup } from './register-test-cleanup';

interface StubClosingListener {
  readonly stop: () => void;
}

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

  const stop = registerTestCleanup(() => {
    server.stop(true);
  });

  return {
    stop,
  };
}
