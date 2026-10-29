import type { Socket } from 'bun';
import { registerTestCleanup } from './register-test-cleanup';

interface StubStallingProxy {
  readonly port: number;

  // Drops every byte in both directions from now on, and every close, as a
  // network path that loses its packets does: neither end hears anything.
  readonly stall: () => void;

  // How many bytes it has dropped, in both directions together.
  readonly countDroppedBytes: () => number;

  readonly stop: () => void;
}

interface ProxiedConnection {
  upstream: Socket | null;
  readonly queued: Uint8Array[];
}

// A TCP proxy to a port on 127.0.0.1 that forwards each connection until it
// stalls.
export function startStubStallingProxy(targetPort: number): StubStallingProxy {
  const state = { stalled: false, droppedBytes: 0 };

  const clients = new Set<Socket<ProxiedConnection>>();

  const server = Bun.listen<ProxiedConnection>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open: (client) => {
        clients.add(client);

        client.data = { upstream: null, queued: [] };

        void Bun.connect({
          hostname: '127.0.0.1',
          port: targetPort,
          socket: {
            open: (upstream) => {
              client.data.upstream = upstream;

              for (const bytes of client.data.queued.splice(0)) {
                upstream.write(bytes);
              }
            },
            data: (_upstream, bytes) => {
              if (state.stalled) {
                state.droppedBytes += bytes.byteLength;
              } else {
                client.write(bytes);
              }
            },
            close: () => {
              if (!state.stalled) {
                client.end();
              }
            },
          },
        });
      },
      data: (client, bytes) => {
        if (state.stalled) {
          state.droppedBytes += bytes.byteLength;

          return;
        }

        const upstream = client.data.upstream;

        if (upstream === null) {
          client.data.queued.push(new Uint8Array(bytes));
        } else {
          upstream.write(bytes);
        }
      },
      close: (client) => {
        clients.delete(client);

        if (!state.stalled) {
          client.data.upstream?.end();
        }
      },
    },
  });

  const stop = registerTestCleanup(() => {
    for (const client of clients) {
      client.data.upstream?.end();
      client.end();
    }

    server.stop(true);
  });

  return {
    port: server.port,
    stall: () => {
      state.stalled = true;
    },
    countDroppedBytes: () => state.droppedBytes,
    stop,
  };
}
