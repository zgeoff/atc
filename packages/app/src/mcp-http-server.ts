import type { Database } from 'bun:sqlite';
import type { MCPHTTPConfig } from '@atc/config';
import {
  NODE_TOKEN_FILE_ACCESS,
  loadListenerTokens,
  loadMCPHTTPConfig,
  mcpAuthDBFile,
} from '@atc/config';
import { systemClock } from '@atc/core';
import type { ChannelCaller, WatchChannel } from '@atc/mcp';
import { findMCPResource, openATCAuthAdmin, startMCPHTTPServer } from '@atc/mcp';
import type { DaemonBoot, DaemonBootOptions, DaemonPaths } from '@atc/protocol';
import { GATEWAY_PATHS } from '@atcx/contract';
import { loadServiceTokenFile } from './load-service-token-file';
import { PROCESS_IO } from './process-io';
import type { ProcessIO } from './process-io';
import { registerServiceTokenReload } from './register-service-token-reload';

interface MCPHTTPFlags {
  readonly host: string | null;
  readonly port: number | null;
  readonly publicURL: string | null;
  readonly waitForDaemon: boolean;
  readonly tokenFile: string | null;

  // The file of service tokens `/mcp` accepts; null for none.
  readonly serviceTokenFile: string | null;
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
  readonly openAuthDatabase: (path: string) => Database;
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

  const serviceTokens =
    flags.serviceTokenFile === null
      ? null
      : loadServiceTokenFile(flags.serviceTokenFile, NODE_TOKEN_FILE_ACCESS);

  if (serviceTokens !== null && !serviceTokens.ok) {
    io.printError(`atc mcp --http: --service-token-file: ${serviceTokens.reason}`);
    io.exit(1);

    return;
  }

  // The daemon boots before the server binds, so a file for another resource
  // is refused here, where the origin is already known, with nothing started.
  const expectedResource = findMCPResource(
    flags.publicURL ?? config.publicURL,
    flags.port ?? config.port,
  );

  if (
    serviceTokens !== null &&
    expectedResource !== null &&
    serviceTokens.file.resource !== expectedResource
  ) {
    io.printError(
      `atc mcp --http: --service-token-file: the file names the resource ${serviceTokens.file.resource}, and the server serves ${expectedResource}`,
    );

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
    ...(serviceTokens === null ? {} : { serviceTokens: serviceTokens.file }),

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

  if (flags.serviceTokenFile !== null) {
    registerServiceTokenReload({
      binary: 'atc mcp --http',
      path: flags.serviceTokenFile,
      server,
      io,
    });
  }

  io.print(
    `atc mcp --http: serving ${server.origin}${GATEWAY_PATHS.machine.mcp}, listening on ${server.listening}`,
  );

  const sqlite = host.openAuthDatabase(io.dbPath);

  const admin = await openATCAuthAdmin(sqlite, systemClock);
  const clients = await admin.clients.list();
  const passkeys = await admin.passkeys.list();

  await admin.close();

  sqlite.close();

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
