import { createServer } from 'node:net';
import type { Socket } from 'node:net';

interface StubAnsweringListener {
  // The server's side of each connection it accepted, in order.
  readonly peers: readonly Socket[];

  // The first read each connection sent, decoded, in arrival order.
  readonly lines: readonly string[];
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

/**
 * A stand-in for a daemon socket that answers a handshake: it listens on
 * the unix socket path, records each connection it accepts and the first
 * read each one sends, answers that read with the line `answer`, and
 * leaves every later byte unread on the connection. Resolves once it
 * listens. Disposal destroys every connection it accepted and resolves
 * once the server has closed; hold the result with `await using`.
 */
export async function startStubAnsweringListener(path: string): Promise<StubAnsweringListener> {
  const peers: Socket[] = [];
  const lines: string[] = [];

  const server = createServer((peer) => {
    peers.push(peer);

    peer.once('data', (data) => {
      peer.pause();
      lines.push(data.toString());
      peer.write('answer\n');
    });
  });

  const listening = Promise.withResolvers<void>();

  server.listen(path, () => {
    listening.resolve();
  });

  await listening.promise;

  return {
    peers,
    lines,
    [Symbol.asyncDispose]: async () => {
      for (const peer of peers) {
        peer.destroy();
      }

      const closed = Promise.withResolvers<void>();

      server.close(() => {
        closed.resolve();
      });

      await closed.promise;
    },
  };
}
