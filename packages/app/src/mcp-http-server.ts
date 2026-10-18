import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MCPHTTPConfig } from '@atc/config';
import { loadMCPHTTPConfig, mcpAuthDBFile } from '@atc/config';
import type { DaemonBoot, DaemonBootOptions, DaemonPaths } from '@atc/protocol';
import { DaemonClient } from '@atc/protocol/wire';
import { collectClients } from './mcp/collect-clients';
import { collectPasskeys } from './mcp/collect-passkeys';
import type { MCPAuthDatabase } from './mcp/mcp-auth-database';
import { openMCPAuth } from './mcp/open-mcp-auth';
import { startMCPHTTPServer } from './mcp/start-mcp-http-server';
import { TransportCaller } from './mcp/transport-caller';

interface MCPHTTPFlags {
  readonly host: string | null;
  readonly port: number | null;
  readonly publicURL: string | null;
  readonly waitForDaemon: boolean;
}

interface MCPHTTPServerIO {
  readonly loadConfig: () => MCPHTTPConfig;
  readonly dbPath: string;

  // null for the process's own daemon files, the only ones at which it starts
  // a daemon
  readonly daemonPaths: DaemonPaths | null;
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;
  readonly exit: (code: number) => void;
  readonly registerSignal: (signal: 'SIGINT' | 'SIGTERM', listener: () => Promise<void>) => void;
}

const PROCESS_IO: MCPHTTPServerIO = {
  loadConfig: loadMCPHTTPConfig,
  dbPath: mcpAuthDBFile,
  daemonPaths: null,
  print: (line) => {
    console.log(line);
  },
  printError: (line) => {
    console.error(line);
  },
  exit: (code) => {
    process.exit(code);
  },
  registerSignal: (signal, listener) => {
    process.on(signal, () => {
      void listener();
    });
  },
};

// What the entry wires in: the daemon boot and the opener of the
// authorization database.
interface MCPHTTPServerHost {
  readonly bootDaemon: (options: DaemonBootOptions) => Promise<DaemonBoot>;
  readonly openAuthDatabase: (path: string) => MCPAuthDatabase;
}

// How long `--wait-for-daemon` waits before it exits. A service manager's
// restart covers a daemon that takes longer.
const DAEMON_WAIT_MS = 30_000;

export async function runMCPHTTPServer(
  build: string,
  flags: MCPHTTPFlags,
  host: MCPHTTPServerHost,
  io: MCPHTTPServerIO = PROCESS_IO,
): Promise<void> {
  const config = io.loadConfig();

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

  // A remote connector has no inbox, so the server claims no session even
  // when it was started inside one.
  const caller = new TransportCaller(
    boot.socketPath,
    build,
    (path) => DaemonClient.open(path),
    null,
  );

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

  const clients = await collectClients(admin.db);
  const passkeys = await collectPasskeys(admin.db);

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
