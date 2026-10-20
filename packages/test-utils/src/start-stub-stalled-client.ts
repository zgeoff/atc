import { createConnection } from 'node:net';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { buildPeerRequestLine } from './build-peer-request-line';
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

  // The handshake and the event subscription go out in one write, so the
  // daemon pushes events the client never reads.
  const hello = { client, protocol: PROTOCOL_V, auth: { scheme: 'none' } };

  socket.write(
    buildPeerRequestLine('1', '/daemon/hello', hello) +
      buildPeerRequestLine('2', '/events/subscribe', {}),
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
