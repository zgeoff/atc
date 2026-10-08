import { createConnection } from 'node:net';
import { PROTOCOL_V, encodeMessage } from '../protocol/protocol';
import { registerTestCleanup } from './register-test-cleanup';

interface StubStalledClient {
  // Each chunk the client has read off its connection, in order.
  readonly chunks: readonly unknown[];

  // How many bytes have arrived on the connection and wait unread.
  readonly countUnreadBytes: () => number;
  readonly [Symbol.dispose]: () => void;
}

/**
 * A stand-in for a daemon client that stops reading: it connects to the
 * daemon's unix socket, sends a `daemon.hello` with no auth as `client`,
 * reads the first chunk the daemon sends, and then holds its next read on
 * a promise that never resolves, so whatever the daemon sends it after
 * that backs up. Resolves once that first chunk arrives. The connection is
 * destroyed once the current test finishes, so it must run inside a test;
 * disposal destroys it sooner, and a second stop does nothing.
 */
export async function startStubStalledClient(
  socketPath: string,
  client: string,
): Promise<StubStalledClient> {
  const held = Promise.withResolvers<void>();
  const first = Promise.withResolvers<void>();
  const chunks: unknown[] = [];
  const socket = createConnection(socketPath);

  const stop = registerTestCleanup(() => {
    socket.destroy();
  });

  socket.write(
    encodeMessage({
      v: PROTOCOL_V,
      id: 1,
      m: 'daemon.hello',
      p: { client, auth: { scheme: 'none' } },
    }),
  );

  void (async () => {
    for await (const chunk of socket) {
      chunks.push(chunk);
      first.resolve();

      await held.promise;
    }
  })();

  await first.promise;

  return {
    chunks,
    countUnreadBytes: () => socket.readableLength,
    [Symbol.dispose]: stop,
  };
}
