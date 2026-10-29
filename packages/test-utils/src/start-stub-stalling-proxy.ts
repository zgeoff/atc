import type { Socket } from 'bun';
import { registerTestCleanup } from './register-test-cleanup';

interface StubStallingProxy {
  readonly port: number;

  // Drops every byte in both directions from now on, and every close, as a
  // network path that loses its packets does: neither end hears anything.
  readonly stall: () => void;

  // How many bytes it has dropped, in both directions together.
  readonly countDroppedBytes: () => number;

  // How many client connections it has seen close.
  readonly countClosedClients: () => number;

  readonly stop: () => void;
}

// One end of a proxied connection, with the bytes it has yet to take.
interface ProxiedEnd {
  socket: Socket<unknown> | null;
  readonly unwritten: Uint8Array[];
}

interface ProxiedConnection {
  readonly client: ProxiedEnd;
  readonly upstream: ProxiedEnd;
}

// A TCP proxy to a port on 127.0.0.1 that forwards each connection until it
// stalls. It keeps every connection until it stops, so a stop ends each
// upstream socket that a stalled close left open.
export function startStubStallingProxy(targetPort: number): StubStallingProxy {
  const state = { stalled: false, droppedBytes: 0, closedClients: 0 };

  const connections = new Set<ProxiedConnection>();

  const forward = (destination: ProxiedEnd, bytes: Uint8Array): void => {
    if (state.stalled) {
      state.droppedBytes += bytes.byteLength;

      return;
    }

    destination.unwritten.push(new Uint8Array(bytes));

    writeUnwritten(destination);
  };

  const server = Bun.listen<ProxiedConnection>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open: (client) => {
        const connection: ProxiedConnection = {
          client: { socket: client, unwritten: [] },
          upstream: { socket: null, unwritten: [] },
        };

        client.data = connection;

        connections.add(connection);

        void Bun.connect({
          hostname: '127.0.0.1',
          port: targetPort,
          socket: {
            open: (upstream) => {
              connection.upstream.socket = upstream;

              writeUnwritten(connection.upstream);
            },
            data: (_upstream, bytes) => {
              forward(connection.client, bytes);
            },
            drain: () => {
              writeUnwritten(connection.upstream);
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
        forward(client.data.upstream, bytes);
      },
      drain: (client) => {
        writeUnwritten(client.data.client);
      },
      close: (client) => {
        state.closedClients += 1;

        if (!state.stalled) {
          client.data.upstream.socket?.end();
        }
      },
    },
  });

  const stop = registerTestCleanup(() => {
    for (const connection of connections) {
      connection.upstream.socket?.end();
      connection.client.socket?.end();
    }

    server.stop(true);
  });

  return {
    port: server.port,
    stall: () => {
      state.stalled = true;
    },
    countDroppedBytes: () => state.droppedBytes,
    countClosedClients: () => state.closedClients,
    stop,
  };
}

// A socket's write takes only what its buffer holds, so the rest waits for
// its drain.
function writeUnwritten(end: ProxiedEnd): void {
  const socket = end.socket;

  if (socket === null) {
    return;
  }

  for (let head = end.unwritten.shift(); head !== undefined; head = end.unwritten.shift()) {
    const written = Math.max(0, socket.write(head));

    if (written < head.byteLength) {
      end.unwritten.unshift(head.subarray(written));

      return;
    }
  }
}
