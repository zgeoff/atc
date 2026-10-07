import { createServer } from 'node:net';
import type { Socket } from 'node:net';

interface StubStalledListener {
  readonly [Symbol.dispose]: () => void;
}

/**
 * A stand-in for a peer that stops reading: it listens on the unix socket
 * path and accepts every connection but never reads from it, so what the
 * kernel does not buffer stays queued on the sender's side. Resolves once
 * it listens. Disposal destroys every connection it accepted and stops it;
 * hold the result with `using`.
 */
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

  return {
    [Symbol.dispose]: () => {
      for (const peer of peers) {
        peer.destroy();
      }

      server.close();
    },
  };
}
