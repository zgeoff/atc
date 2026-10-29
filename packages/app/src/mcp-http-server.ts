import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MCPHTTPConfig } from '@atc/config';
import {
  NODE_TOKEN_FILE_ACCESS,
  loadListenerTokens,
  loadMCPHTTPConfig,
  mcpAuthDBFile,
} from '@atc/config';
import type { ChannelCaller, MCPAuthDatabase, WatchChannel } from '@atc/mcp';
import { openMCPAuth, readClientViews, readPasskeyViews, startMCPHTTPServer } from '@atc/mcp';
import type { DaemonBoot, DaemonBootOptions, DaemonPaths } from '@atc/protocol';
import { PROCESS_IO } from './process-io';
import type { ProcessIO } from './process-io';

interface MCPHTTPFlags {
  readonly host: string | null;
  readonly port: number | null;
  readonly publicURL: string | null;
  readonly waitForDaemon: boolean;
  readonly tokenFile: string | null;
  readonly allowedOrigins: readonly string[];
}

interface MCPHTTPServerIO extends Pick<
  ProcessIO,
  'print' | 'printError' | 'exit' | 'registerSignal'
> {
  readonly loadConfig: () => MCPHTTPConfig;
  readonly loadTokens: (path: string) => ReturnType<typeof loadListenerTokens>;
  readonly dbPath: string;

  // null for the process's own daemon files, the only ones at which it starts
  // a daemon
  readonly daemonPaths: DaemonPaths | null;
}

const MCP_HTTP_SERVER_IO: MCPHTTPServerIO = {
  ...PROCESS_IO,
  loadConfig: loadMCPHTTPConfig,
  loadTokens: (path) => loadListenerTokens(path, NODE_TOKEN_FILE_ACCESS),
  dbPath: mcpAuthDBFile,
  daemonPaths: null,
};

// How the server reaches the daemon it booted: the caller its tools use, as
// the daemon's owner, and the opener of a live-terminal viewer's own channel.
export interface MCPDaemonConnection {
  readonly caller: ChannelCaller;

  // A null principal watches as the connection's own principal.
  readonly openWatchChannel: (principal: string | null) => Promise<WatchChannel>;
}

// What the entry wires in: the daemon boot, the connection to the booted
// daemon, and the opener of the authorization database.
interface MCPHTTPServerHost {
  readonly bootDaemon: (options: DaemonBootOptions) => Promise<DaemonBoot>;
  readonly connectDaemon: (boot: DaemonBoot) => MCPDaemonConnection;
  readonly openAuthDatabase: (path: string) => MCPAuthDatabase;
}

// How long `--wait-for-daemon` waits before it exits. A service manager's
// restart covers a daemon that takes longer.
const DAEMON_WAIT_MS = 30_000;

export async function runMCPHTTPServer(
  build: string,
  flags: MCPHTTPFlags,
  host: MCPHTTPServerHost,
  io: MCPHTTPServerIO = MCP_HTTP_SERVER_IO,
): Promise<void> {
  const config = io.loadConfig();

  // A token file is read once, before the daemon starts, so a bad file
  // stops the server with nothing started.
  const loaded = flags.tokenFile === null ? null : io.loadTokens(flags.tokenFile);

  if (loaded !== null && !loaded.ok) {
    io.printError(`atc mcp --http: --token-file: ${loaded.reason}`);
    io.exit(1);

    return;
  }

  const waitOptions = flags.waitForDaemon
    ? {
        waitForDaemonMs: DAEMON_WAIT_MS,
        onWaitForDaemon: () => {
          io.printError(
            `atc mcp --http: no daemon answers yet; waiting up to ${DAEMON_WAIT_MS / 1000}s for one, without starting it`,
          );
        },
      }
    : {};

  const bootOptions =
    io.daemonPaths === null ? waitOptions : { ...waitOptions, paths: io.daemonPaths };

  let boot: DaemonBoot;

  try {
    boot = await host.bootDaemon(bootOptions);
  } catch (error) {
    io.printError(`atc mcp --http: ${error instanceof Error ? error.message : String(error)}`);
    io.exit(1);

    return;
  }

  boot.client.stop();

  mkdirSync(dirname(io.dbPath), { recursive: true });

  const connection = host.connectDaemon(boot);
  const caller = connection.caller;

  const server = await startMCPHTTPServer({
    caller,
    build,
    host: flags.host ?? config.host,
    port: flags.port ?? config.port,
    publicURL: flags.publicURL ?? config.publicURL,
    allowedHosts: config.allowedHosts,
    trustForwardedFrom: config.trustForwardedFrom,
    dbPath: io.dbPath,
    openAuthDatabase: host.openAuthDatabase,

    // Request lines go to stderr, beside the security events.
    printRequest: (line) => {
      io.printError(line);
    },

    // A log shipper matches the `atc security ` prefix of these lines.
    printSecurity: (line) => {
      io.printError(line);
    },

    liveTerminals: {
      allowedOrigins: [...config.allowedOrigins, ...flags.allowedOrigins],
      ownerTokens: loaded?.tokens ?? [],
      openWatchChannel: connection.openWatchChannel,
    },
  });

  // The handlers go in before the serving line, so a signal sent once the
  // line appears always finds them.
  const stopServing = async () => {
    await server.stop();
    await caller.stop();

    io.exit(0);
  };

  io.registerSignal('SIGINT', stopServing);
  io.registerSignal('SIGTERM', stopServing);
  io.print(`atc mcp --http: serving ${server.origin}/mcp, listening on ${server.listening}`);

  const admin = await openMCPAuth({
    dbPath: io.dbPath,
    openDatabase: host.openAuthDatabase,
    origin: null,
  });

  const clients = await readClientViews(admin.db);
  const passkeys = await readPasskeyViews(admin.db);

  await admin.close();

  if (clients.length === 0) {
    io.print(
      'No clients can connect yet. Add one with: atc clients add <name> --redirect-uri <uri>',
    );
  }

  if (passkeys.length === 0) {
    io.print(
      'No passkey is enrolled, so nobody can sign in yet. Enroll one with: atc passkeys enroll',
    );
  }
}
