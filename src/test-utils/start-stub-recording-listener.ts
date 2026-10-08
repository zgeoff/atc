import type { Socket } from 'bun';
import { registerTestCleanup } from './register-test-cleanup';

interface StubRecordingListener {
  // Resolves with the server's side of the first connection it accepts.
  readonly accepted: Promise<Socket>;

  // What each read took from any connection, decoded, in arrival order.
  readonly received: readonly string[];
  readonly [Symbol.dispose]: () => void;
}

/**
 * A stand-in for a peer that a test writes through: it listens on the unix
 * socket path, hands the test the server's side of the first connection it
 * accepts, records what each read takes from any connection, and sends
 * nothing of its own. It stops, dropping every connection it holds, once
 * the current test finishes, so it must run inside a test; disposal stops it
 * sooner, and a second stop does nothing.
 */
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
    [Symbol.dispose]: stop,
  };
}
