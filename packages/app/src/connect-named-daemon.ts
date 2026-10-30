import type { RemoteDaemon } from '@atc/config';
import { bootRemoteDaemonClient } from './boot-remote-daemon-client';
import { createNamedDaemonConnection } from './create-named-daemon-connection';
import type { MCPDaemonConnection } from './mcp-http-server';

// Each channel is a fresh boot of the daemon's client, which reads the token
// again, so a token rotated on the daemon's host reaches the next channel
// without a restart.
export function connectNamedDaemon(daemon: RemoteDaemon, build: string): MCPDaemonConnection {
  return createNamedDaemonConnection({
    name: daemon.name,
    openChannel: async (viewer) => {
      const options = viewer === null ? {} : { viewer };

      const boot = await bootRemoteDaemonClient(daemon, build, options);

      return boot.client;
    },
  });
}
