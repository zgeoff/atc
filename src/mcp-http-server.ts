import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { bootDaemonClient } from './client/boot-daemon';
import type { DaemonBoot, DaemonBootOptions } from './client/boot-daemon';
import { DaemonClient } from './client/daemon-client';
import { collectClients } from './mcp/collect-clients';
import { openMCPAuth } from './mcp/open-mcp-auth';
import { ReconnectingCaller } from './mcp/reconnecting-caller';
import { startMCPHTTPServer } from './mcp/start-mcp-http-server';
import type { MCPHTTPConfig } from './shared/collect-mcp-http-config';
import { mcpAuthDBFile } from './shared/config';
import { loadMCPHTTPConfig } from './shared/load-mcp-http-config';

interface MCPHTTPFlags {
  readonly host: string | null;
  readonly port: number | null;
  readonly publicURL: string | null;
  readonly waitForDaemon: boolean;
}

// What the server reaches outside itself, the process's own by default: its
// config, the authorization database, the daemon it boots or waits for, the
// console, the exit, and the signal listeners that stop it.
interface MCPHTTPServerIO {
  readonly loadConfig: () => MCPHTTPConfig;
  readonly dbPath: string;
  readonly bootDaemon: (
    options: DaemonBootOptions,
  ) => Promise<Pick<DaemonBoot, 'client' | 'socketPath'>>;
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;
  readonly exit: (code: number) => void;
  readonly registerSignal: (signal: 'SIGINT' | 'SIGTERM', listener: () => Promise<void>) => void;
}

const PROCESS_IO: MCPHTTPServerIO = {
  loadConfig: loadMCPHTTPConfig,
  dbPath: mcpAuthDBFile,
  bootDaemon: bootDaemonClient,
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

// How long `--wait-for-daemon` waits before it exits. A service manager's
// restart covers a daemon that takes longer.
const DAEMON_WAIT_MS = 30_000;

/**
 * Runs `atc mcp --http` in the foreground: boots the daemon when it is down,
 * or with `--wait-for-daemon` waits for one and exits when none answers, and
 * serves MCP over HTTP until Ctrl-C. Approval codes print here, so the
 * terminal running it is where the operator approves a client.
 */
export async function runMCPHTTPServer(
  build: string,
  flags: MCPHTTPFlags,
  io: MCPHTTPServerIO = PROCESS_IO,
): Promise<void> {
  const config = io.loadConfig();

  const bootOptions = flags.waitForDaemon
    ? {
        waitForDaemonMs: DAEMON_WAIT_MS,
        onWaitForDaemon: () => {
          io.printError(
            `atc mcp --http: no daemon answers yet; waiting up to ${DAEMON_WAIT_MS / 1000}s for one, without starting it`,
          );
        },
      }
    : {};

  let boot: Pick<DaemonBoot, 'client' | 'socketPath'>;

  try {
    boot = await io.bootDaemon(bootOptions);
  } catch (error) {
    io.printError(`atc mcp --http: ${error instanceof Error ? error.message : String(error)}`);
    io.exit(1);

    return;
  }

  boot.client.stop();

  mkdirSync(dirname(io.dbPath), { recursive: true });

  const caller = new ReconnectingCaller(boot.socketPath, build, (path) => DaemonClient.open(path));

  const server = await startMCPHTTPServer({
    caller,
    build,
    host: flags.host ?? config.host,
    port: flags.port ?? config.port,
    publicURL: flags.publicURL ?? config.publicURL,
    allowedHosts: config.allowedHosts,
    dbPath: io.dbPath,

    // The line carries a client's name, so control and format characters
    // are dropped before it reaches the operator's terminal.
    printApproval: (line) => {
      io.print(line.replaceAll(/[\p{Cc}\p{Cf}]/gu, ''));
    },

    // Request lines go to stderr, so stdout keeps the approval lines alone.
    printRequest: (line) => {
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

  const admin = await openMCPAuth({ dbPath: io.dbPath, origin: null });
  const clients = await collectClients(admin.db);

  await admin.close();

  if (clients.length === 0) {
    io.print(
      'No clients can connect yet. Add one with: atc clients add <name> --redirect-uri <uri>',
    );
  }
}
