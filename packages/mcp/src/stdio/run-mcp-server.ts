import type { DaemonBoot } from '@atc/protocol';
import { openDaemonClient } from '@atc/protocol/client';
import { readSessionEnv } from '@atc/protocol/session';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createMCPServer } from '../tools/create-mcp-server';
import { createTransportCaller } from '../tools/create-transport-caller';
import { findBridgeSocket } from './find-bridge-socket';

export async function runMCPServer(
  build: string,
  bootDaemon: () => Promise<DaemonBoot>,
): Promise<void> {
  const sessionEnv = readSessionEnv(process.env);
  const bridgeSocket = findBridgeSocket(sessionEnv);

  const socketPath = await resolveSocketPath(bridgeSocket, bootDaemon);

  // a spawn from inside a session nests under it by default, and each
  // connection's handshake claims that session for the answers to the
  // messages it sends
  const callerSessionID = sessionEnv.sessionID ?? null;

  const caller = createTransportCaller(
    socketPath,
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

async function resolveSocketPath(
  bridgeSocket: string | null,
  bootDaemon: () => Promise<DaemonBoot>,
): Promise<string> {
  if (bridgeSocket !== null) {
    return bridgeSocket;
  }

  const boot = await bootDaemon();

  boot.client.stop();

  return boot.socketPath;
}
