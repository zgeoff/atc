import { registerTestCleanup } from '@atc/test-utils';
import type { DaemonContext } from '../daemon-context';
import { DaemonConnection } from '../transport/daemon-connection';

// Serves the daemon's connections on a unix socket, each on the given
// context, the way the daemon's own listener wires them, and returns the
// connections it accepts; the test's end stops it.
export function startConnectionListener(
  socketPath: string,
  ctx: DaemonContext,
): readonly DaemonConnection[] {
  const connections: DaemonConnection[] = [];

  const server = Bun.listen<DaemonConnection>({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.data = new DaemonConnection(socket, ctx);

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
