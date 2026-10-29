import type { RemoteDaemon } from '@atc/config';
import { bootRemoteDaemonClient } from './boot-remote-daemon-client';
import { createNamedDaemonConnection } from './create-named-daemon-connection';
import { makeRemoteChannelOpener } from './make-remote-channel-opener';
import type { MCPDaemonConnection } from './mcp-http-server';
import { PROCESS_IO } from './process-io';

export function connectNamedDaemon(daemon: RemoteDaemon, build: string): MCPDaemonConnection {
  return createNamedDaemonConnection({
    name: daemon.name,
    principal: daemon.principal,
    openChannel: makeRemoteChannelOpener(daemon, (opened) => bootRemoteDaemonClient(opened, build)),
    printError: PROCESS_IO.printError,
  });
}
