import { bootDaemonClient } from './client/boot-daemon';
import { ReconnectingCaller } from './mcp/reconnecting-caller';
import { startMCPHTTPServer } from './mcp/start-mcp-http-server';
import { DaemonError } from './protocol/daemon-error';
import { daemonSocketPath } from './shared/config';
import { loadMCPHTTPConfig } from './shared/load-mcp-http-config';

interface MCPHTTPFlags {
  readonly port: number | null;
  readonly publicURL: string | null;
}

/**
 * Runs `atc mcp --http` in the foreground: boots the daemon when it is down,
 * refuses a daemon too old to hold grants, and serves MCP over HTTP until
 * Ctrl-C. Approval codes print here, so the terminal running it is where the
 * operator approves a client.
 */
export async function runMCPHTTPServer(build: string, flags: MCPHTTPFlags): Promise<void> {
  const config = loadMCPHTTPConfig();

  const boot = await bootDaemonClient();

  try {
    await boot.client.sendRequest('grant.list');
  } catch (error) {
    if (error instanceof DaemonError && error.code === 'unknown_method') {
      console.error(
        'atc mcp --http: the running daemon is older than this build and cannot hold grants. Open atc and press u to restart it, then run this again.',
      );

      process.exit(1);
    }

    throw error;
  } finally {
    boot.client.stop();
  }

  const caller = new ReconnectingCaller(daemonSocketPath, build);

  const server = startMCPHTTPServer({
    caller,
    build,
    port: flags.port ?? config.port,
    publicURL: flags.publicURL ?? config.publicURL,
    allowedHosts: config.allowedHosts,
    metadataHosts: config.clientMetadataHosts,
    printApproval: (line) => {
      console.log(line);
    },
  });

  console.log(`atc mcp --http: serving ${server.origin}/mcp, listening on ${server.url}`);

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
