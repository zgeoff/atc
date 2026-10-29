import type { DaemonBoot } from '@atc/protocol';
import { openDaemonClient } from '@atc/protocol/client';
import { readSessionEnv } from '@atc/protocol/session';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { match } from 'ts-pattern';
import type { ChannelCaller } from '../tools/create-channel-caller';
import { createMCPServer } from '../tools/create-mcp-server';
import { createTransportCaller } from '../tools/create-transport-caller';
import { findBridgeSocket } from './find-bridge-socket';

// The daemon the tools call: the local one, booted when none answers, or a
// daemon of the config's daemons map, through the caller the entry builds.
type MCPServerDaemon =
  | { readonly kind: 'local'; readonly boot: () => Promise<DaemonBoot> }
  | { readonly kind: 'named'; readonly caller: ChannelCaller };

export async function runMCPServer(build: string, daemon: MCPServerDaemon): Promise<void> {
  const served = await match(daemon)
    .with({ kind: 'local' }, (local) => openLocalCaller(build, local.boot))
    .with({ kind: 'named' }, (named) => ({
      caller: named.caller,

      // the session this server runs inside lives on the local daemon, so the
      // named daemon knows no such session to nest a spawn under
      callerSessionID: null,
    }))
    .exhaustive();

  const server = createMCPServer({
    caller: served.caller,
    build,
    toolContext: { callerSessionID: served.callerSessionID },
  });

  const closed = Promise.withResolvers<void>();

  // the transport closes once the client closes stdin, and the SDK's server
  // takes its close callback as a property, with no addEventListener
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  server.server.onclose = () => {
    closed.resolve();
  };

  await server.connect(new StdioServerTransport());

  await closed.promise;

  await served.caller.stop();
}

interface ServedCaller {
  readonly caller: ChannelCaller;
  readonly callerSessionID: string | null;
}

async function openLocalCaller(
  build: string,
  bootDaemon: () => Promise<DaemonBoot>,
): Promise<ServedCaller> {
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

  return { caller, callerSessionID };
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
