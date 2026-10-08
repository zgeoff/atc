import { registerTestCleanup } from './register-test-cleanup';

interface StubClosingListener {
  readonly stop: () => void;
}

/**
 * A stand-in for a daemon that hangs up: it listens on the unix socket path
 * and ends every connection as soon as it opens, reading nothing. It stops
 * once the current test finishes, so it must run inside a test; `stop`
 * stops it sooner, and a second stop does nothing.
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

  const stop = registerTestCleanup(() => {
    server.stop(true);
  });

  return {
    stop,
  };
}
