import { createConnection } from 'node:net';
import { PROTOCOL_V, encodeMessage } from '@atc/protocol/wire';
import { registerTestCleanup } from './register-test-cleanup';

interface StubStalledClient {
  // Each chunk the client has read off its connection, in order.
  readonly chunks: readonly unknown[];

  // How many bytes have arrived on the connection and wait unread.
  readonly countUnreadBytes: () => number;
  readonly stop: () => void;
}

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
    stop,
  };
}
