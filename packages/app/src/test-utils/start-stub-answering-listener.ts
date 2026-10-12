import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { registerTestCleanup } from './register-test-cleanup';

interface StubAnsweringListener {
  // The server's side of each connection it accepted, in order.
  readonly peers: readonly Socket[];

  // The first read each connection sent, decoded, in arrival order.
  readonly lines: readonly string[];
  readonly stop: () => Promise<void>;
}

/**
 * A stand-in for a daemon socket that answers a handshake: it listens on
 * the unix socket path, records each connection it accepts and the first
 * read each one sends, answers that read with the line `answer`, and
 * leaves every later byte unread on the connection. Resolves once it
 * listens. Once the current test finishes, it destroys every connection it
 * accepted and closes, so it must run inside a test; `stop` does so
 * sooner and resolves once the server has closed, and a second stop does
 * nothing.
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

  const stop = registerTestCleanup(async () => {
    for (const peer of peers) {
      peer.destroy();
    }

    const closed = Promise.withResolvers<void>();

    server.close(() => {
      closed.resolve();
    });

    await closed.promise;
  });

  return {
    peers,
    lines,
    stop,
  };
}
