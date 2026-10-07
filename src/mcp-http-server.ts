import { mkdirSync } from 'node:fs';
import { bootDaemonClient } from './client/boot-daemon';
import { DaemonClient } from './client/daemon-client';
import { collectClients } from './mcp/collect-clients';
import { openMCPAuth } from './mcp/open-mcp-auth';
import { ReconnectingCaller } from './mcp/reconnecting-caller';
import { startMCPHTTPServer } from './mcp/start-mcp-http-server';
import { mcpAuthDBFile, stateDir } from './shared/config';
import { loadMCPHTTPConfig } from './shared/load-mcp-http-config';

interface MCPHTTPFlags {
  readonly host: string | null;
  readonly port: number | null;
  readonly publicURL: string | null;
  readonly waitForDaemon: boolean;
}

// How long `--wait-for-daemon` waits before it exits. A service manager's
// restart covers a daemon that takes longer.
const DAEMON_WAIT_MS = 30_000;

/**
 * Runs `atc mcp --http` in the foreground: boots the daemon when it is down,
 * or with `--wait-for-daemon` waits for one and exits when none answers, and
 * serves MCP over HTTP until Ctrl-C. Approval codes print here, so the
 * terminal running it is where the operator approves a client.
 */
export async function runMCPHTTPServer(build: string, flags: MCPHTTPFlags): Promise<void> {
  const config = loadMCPHTTPConfig();

  const bootOptions = flags.waitForDaemon
    ? {
        waitForDaemonMs: DAEMON_WAIT_MS,
        onWaitForDaemon: () => {
          console.error(
            `atc mcp --http: no daemon answers yet; waiting up to ${DAEMON_WAIT_MS / 1000}s for one, without starting it`,
          );
        },
      }
    : {};

  const boot = await bootDaemonClient(bootOptions).catch((error: unknown) => {
    console.error(`atc mcp --http: ${error instanceof Error ? error.message : String(error)}`);

    return process.exit(1);
  });

  boot.client.stop();

  mkdirSync(stateDir, { recursive: true });

  const caller = new ReconnectingCaller(boot.socketPath, build, (path) => DaemonClient.open(path));

  const server = await startMCPHTTPServer({
    caller,
    build,
    host: flags.host ?? config.host,
    port: flags.port ?? config.port,
    publicURL: flags.publicURL ?? config.publicURL,
    allowedHosts: config.allowedHosts,
    dbPath: mcpAuthDBFile,

    // The line carries a client's name, so control and format characters
    // are dropped before it reaches the operator's terminal.
    printApproval: (line) => {
      console.log(line.replaceAll(/[\p{Cc}\p{Cf}]/gu, ''));
    },

    // Request lines go to stderr, so stdout keeps the approval lines alone.
    printRequest: (line) => {
      console.error(line);
    },
  });

  console.log(`atc mcp --http: serving ${server.origin}/mcp, listening on ${server.listening}`);

  const admin = await openMCPAuth({ dbPath: mcpAuthDBFile, origin: null });
  const clients = await collectClients(admin.db);

  await admin.close();

  if (clients.length === 0) {
    console.log(
      'No clients can connect yet. Add one with: atc clients add <name> --redirect-uri <uri>',
    );
  }

  const stopServing = async () => {
    await server.stop();
    await caller.stop();

    process.exit(0);
  };

  process.on('SIGINT', () => {
    void stopServing();
  });

  process.on('SIGTERM', () => {
    void stopServing();
  });
}
