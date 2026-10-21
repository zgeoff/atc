import type { DaemonBoot } from '@atc/protocol';
import { openDaemonClient } from '@atc/protocol/client';
import { readSessionEnv } from '@atc/protocol/session';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createMCPServer } from '../tools/create-mcp-server';
import { TransportCaller } from '../tools/transport-caller';

export async function runMCPServer(
  build: string,
  bootDaemon: () => Promise<DaemonBoot>,
): Promise<void> {
  const boot = await bootDaemon();

  boot.client.stop();

  // a spawn from inside a session nests under it by default, and each
  // connection's handshake claims that session for the answers to the
  // messages it sends
  const callerSessionID = readSessionEnv(process.env).sessionID ?? null;

  const caller = new TransportCaller(
    boot.socketPath,
    build,
    (path) => openDaemonClient(path),
    callerSessionID,
  );

  const server = createMCPServer({ caller, build, toolContext: { callerSessionID } });
  const closed = Promise.withResolvers<void>();

  // the transport closes once the client closes stdin, and the SDK's server
  // takes its close callback as a property, with no addEventListener
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  server.server.onclose = () => {
    closed.resolve();
  };

  await server.connect(new StdioServerTransport());

  await closed.promise;

  await caller.stop();
}
