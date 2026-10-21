import { registerTestCleanup } from '@atc/test-utils';
import type { DaemonContext } from '../daemon-context';
import { createDaemonConnection } from '../transport/create-daemon-connection';
import type { DaemonConnection } from '../transport/create-daemon-connection';
import type { TCPPeer } from '../transport/tcp-peer';

// Serves the daemon's connections on a unix socket the way its listener
// wires them, checked as TCP connections when given a TCP peer, and returns
// the connections it accepts; the test's end stops it.
export function startConnectionListener(
  socketPath: string,
  ctx: DaemonContext,
  tcp: TCPPeer | null = null,
): readonly DaemonConnection[] {
  const connections: DaemonConnection[] = [];

  const server = Bun.listen<DaemonConnection>({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.data = createDaemonConnection(socket, ctx, tcp);

        connections.push(socket.data);
      },
      data(socket, buf) {
        socket.data.applyChunk(socket.data.decodeChunk(buf));
      },
      drain(socket) {
        socket.data.drain();
      },
      close(socket) {
        socket.data.dispose();
      },
      error() {},
    },
  });

  registerTestCleanup(() => {
    server.stop(true);
  });

  return connections;
}
