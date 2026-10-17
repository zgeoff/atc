import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { registerTestCleanup } from './register-test-cleanup';

interface StubStalledListener {
  readonly stop: () => void;
}

export async function startStubStalledListener(path: string): Promise<StubStalledListener> {
  const peers = new Set<Socket>();

  const server = createServer((peer) => {
    peer.pause();
    peers.add(peer);
  });

  const listening = Promise.withResolvers<void>();

  server.listen(path, () => {
    listening.resolve();
  });

  await listening.promise;

  const stop = registerTestCleanup(() => {
    for (const peer of peers) {
      peer.destroy();
    }

    server.close();
  });

  return {
    stop,
  };
}
