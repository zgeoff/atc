import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadGatewayRegistry, openGatewayCaller } from '@atc/gateway';
import { startMCPHTTPServer } from '@atc/mcp';
import type { MCPHTTPServer } from '@atc/mcp';
import { openDaemonClient } from '@atc/protocol/client';
import { openSQLite } from '@atc/store/sqlite';
import { GATEWAY_PATHS } from '@atcx/contract';
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

  mkdirSync(flags.stateDir, { recursive: true });

  const gateway = openGatewayCaller({
    registry: loaded.registry,
    build,
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
    bindings: openSQLite(join(flags.stateDir, 'gateway.db'), { strict: true }),
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
      dbPath: join(flags.stateDir, 'mcp-auth.db'),
      openAuthDatabase: openMCPAuthDatabase,
      probes: true,

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
