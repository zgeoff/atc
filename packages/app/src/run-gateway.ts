import { mkdirSync } from 'node:fs';
import { NODE_TOKEN_FILE_ACCESS } from '@atc/config/token-file';
import { loadGatewayRegistry, openGatewayCaller } from '@atc/gateway';
import { startMCPHTTPServer } from '@atc/mcp';
import type { MCPHTTPServer } from '@atc/mcp';
import { openDaemonClient } from '@atc/protocol/client';
import { openSQLite } from '@atc/store/sqlite';
import { GATEWAY_PATHS } from '@atcx/contract';
import { buildGatewayStatePaths } from './build-gateway-state-paths';
import { loadServiceTokenFile } from './load-service-token-file';
import { openMCPAuthDatabase } from './open-mcp-auth-database';
import { PROCESS_IO } from './process-io';
import type { ProcessIO } from './process-io';

interface GatewayFlags {
  readonly host: string;
  readonly port: number;
  readonly publicURL: string;

  // The proxy addresses whose forwarded client address the gateway trusts.
  readonly trustForwardedFrom: readonly string[];
  readonly registryPath: string;
  readonly stateDir: string;

  // The file of service tokens `/mcp` accepts; null for none.
  readonly serviceTokenFile: string | null;
}

interface GatewayIO extends Pick<ProcessIO, 'print' | 'printError' | 'exit' | 'registerSignal'> {
  readonly env: Readonly<Record<string, string | undefined>>;
}

const GATEWAY_IO: GatewayIO = { ...PROCESS_IO, env: process.env };

export async function runGateway(
  build: string,
  flags: GatewayFlags,
  io: GatewayIO = GATEWAY_IO,
): Promise<void> {
  const loaded = loadGatewayRegistry(flags.registryPath, io.env);

  if (!loaded.ok) {
    for (const error of loaded.errors) {
      io.printError(`atc-gateway: ${error}`);
    }

    io.exit(1);

    return;
  }

  // The file is read once, before anything starts, so a bad file stops the
  // gateway with nothing opened.
  const serviceTokens =
    flags.serviceTokenFile === null
      ? null
      : loadServiceTokenFile(flags.serviceTokenFile, NODE_TOKEN_FILE_ACCESS);

  if (serviceTokens !== null && !serviceTokens.ok) {
    io.printError(`atc-gateway: --service-token-file: ${serviceTokens.reason}`);
    io.exit(1);

    return;
  }

  mkdirSync(flags.stateDir, { recursive: true });

  const statePaths = buildGatewayStatePaths(flags.stateDir);

  const gateway = openGatewayCaller({
    registry: loaded.registry,
    build,
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
    bindings: openSQLite(statePaths.bindingsDBFile, { strict: true }),
    onWarning: (message) => {
      io.printError(`atc-gateway: ${message}`);
    },
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
      trustForwardedFrom: flags.trustForwardedFrom,
      dbPath: statePaths.mcpAuthDBFile,
      openAuthDatabase: openMCPAuthDatabase,
      probes: true,
      ...(serviceTokens === null ? {} : { serviceTokens: serviceTokens.file }),

      // Request lines go to stderr, beside the security events.
      printRequest: (line) => {
        io.printError(line);
      },

      // A log shipper matches the `atc security ` prefix of these lines.
      printSecurity: (line) => {
        io.printError(line);
      },
    });
  } catch (error) {
    await gateway.stop();

    io.printError(`atc-gateway: ${error instanceof Error ? error.message : String(error)}`);
    io.exit(1);

    return;
  }

  // The handlers go in before the serving line, so a signal sent once the
  // line appears always finds them.
  const stopServing = async () => {
    await server.stop();
    await gateway.stop();

    io.exit(0);
  };

  io.registerSignal('SIGINT', stopServing);
  io.registerSignal('SIGTERM', stopServing);

  io.print(
    `atc-gateway: serving ${server.origin}${GATEWAY_PATHS.machine.mcp}, listening on ${server.listening}`,
  );
}
