import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from './client/daemon-client';
import { loadGatewayRegistry } from './federation/load-gateway-registry';
import { openGatewayCaller } from './federation/open-gateway-caller';
import { startMCPHTTPServer } from './mcp/start-mcp-http-server';
import type { MCPHTTPServer } from './mcp/start-mcp-http-server';

interface GatewayFlags {
  readonly host: string;
  readonly port: number;
  readonly publicURL: string;
  readonly registryPath: string;
  readonly stateDir: string;
}

/**
 * Runs `atc-gateway` in the foreground: serves the MCP tools over HTTP for
 * the daemons the registry lists, routing every call to one of them over
 * TCP, until SIGINT or SIGTERM. It never starts or reaches a local daemon.
 * The keyed-request bindings (`gateway.db`) and the authorization server
 * (`mcp-auth.db`) live in the state directory, the only place it writes. A
 * registry that fails to load, or a server that fails to start, prints the
 * reason and exits 1.
 */
export async function runGateway(build: string, flags: GatewayFlags): Promise<void> {
  const loaded = loadGatewayRegistry(flags.registryPath, process.env);

  if (!loaded.ok) {
    for (const error of loaded.errors) {
      console.error(`atc-gateway: ${error}`);
    }

    process.exit(1);
  }

  mkdirSync(flags.stateDir, { recursive: true });

  const gateway = openGatewayCaller({
    registry: loaded.registry,
    build,
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
    gatewayDBPath: join(flags.stateDir, 'gateway.db'),
  });

  let server: MCPHTTPServer;

  try {
    server = await startMCPHTTPServer({
      caller: gateway.caller,
      build,
      host: flags.host,
      port: flags.port,
      publicURL: flags.publicURL,
      allowedHosts: [],
      dbPath: join(flags.stateDir, 'mcp-auth.db'),
      probes: true,

      // The line carries a client's name, so control and format characters
      // are dropped before it reaches the log.
      printApproval: (line) => {
        console.log(line.replaceAll(/[\p{Cc}\p{Cf}]/gu, ''));
      },

      // Request lines go to stderr, so stdout keeps the approval lines alone.
      printRequest: (line) => {
        console.error(line);
      },
    });
  } catch (error) {
    await gateway.stop();

    console.error(`atc-gateway: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  console.log(`atc-gateway: serving ${server.origin}/mcp, listening on ${server.listening}`);

  const stopServing = async () => {
    await server.stop();
    await gateway.stop();

    process.exit(0);
  };

  process.on('SIGINT', () => {
    void stopServing();
  });

  process.on('SIGTERM', () => {
    void stopServing();
  });
}
