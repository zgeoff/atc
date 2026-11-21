import { registerTestCleanup } from '@zgeoff/testing';
import { createDaemonConnection } from '../transport/create-daemon-connection';
import type { DaemonConnection, PeerSession } from '../transport/create-daemon-connection';
import type { TCPPeer } from '../transport/tcp-peer';
import type { DaemonContext } from '../types';

export function startConnectionListener(
  socketPath: string,
  ctx: DaemonContext,
  tcp: TCPPeer | null = null,
  peerSession: PeerSession | null = null,
): readonly DaemonConnection[] {
  const connections: DaemonConnection[] = [];

  const server = Bun.listen<DaemonConnection>({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.data = createDaemonConnection(socket, ctx, tcp, peerSession);

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
