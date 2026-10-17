import type { Socket } from 'bun';
import { registerTestCleanup } from './register-test-cleanup';

interface StubRecordingListener {
  // Resolves with the server's side of the first connection it accepts.
  readonly accepted: Promise<Socket>;

  // What each read took from any connection, decoded, in arrival order.
  readonly received: readonly string[];
  readonly stop: () => void;
}

export function startStubRecordingListener(path: string): StubRecordingListener {
  const accepted = Promise.withResolvers<Socket>();
  const received: string[] = [];

  const server = Bun.listen({
    unix: path,
    socket: {
      open(socket) {
        accepted.resolve(socket);
      },
      data(_socket, data) {
        received.push(data.toString());
      },
      error() {},
    },
  });

  const stop = registerTestCleanup(() => {
    server.stop(true);
  });

  return {
    accepted: accepted.promise,
    received,
    stop,
  };
}
