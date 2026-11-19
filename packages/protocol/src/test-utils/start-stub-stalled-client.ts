import { createConnection } from 'node:net';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { PROTOCOL_V } from '../wire/index';
import { buildPeerRequestLine } from './build-peer-request-line';

interface StubStalledClient {
  readonly chunks: readonly unknown[];

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
