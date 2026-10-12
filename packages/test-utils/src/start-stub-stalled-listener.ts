import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { registerTestCleanup } from './register-test-cleanup';

interface StubStalledListener {
  readonly stop: () => void;
}

/**
 * A stand-in for a peer that stops reading: it listens on the unix socket
 * path and accepts every connection but never reads from it, so what the
 * kernel does not buffer stays queued on the sender's side. Resolves once
 * it listens. Once the current test finishes, it destroys every connection
 * it accepted and stops, so it must run inside a test; `stop` does so
 * sooner, and a second stop does nothing.
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
