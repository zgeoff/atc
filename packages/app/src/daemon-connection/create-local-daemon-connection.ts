import { createTransportCaller } from '@atc/mcp';
import { openDaemonClient } from '@atc/protocol/client';
import { openWatchChannel } from '../events/open-watch-channel';
import type { MCPDaemonConnection } from '../mcp/run-mcp-http-server';

export function createLocalDaemonConnection(
  socketPath: string,
  build: string,
): MCPDaemonConnection {
  return {
    // A remote connector has no inbox, so the server claims no session even
    // when it was started inside one.
    caller: createTransportCaller(socketPath, build, (path) => openDaemonClient(path), null),
    openWatchChannel: (principal) => openWatchChannel(socketPath, build, principal),
  };
}
