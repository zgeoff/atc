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

// What the gateway reaches outside itself, the process's own by default:
// the environment its daemon tokens come from, the console, the exit, and
// the signal listeners that stop it.
interface GatewayIO {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;
  readonly exit: (code: number) => void;
  readonly registerSignal: (signal: 'SIGINT' | 'SIGTERM', listener: () => Promise<void>) => void;
}

const PROCESS_IO: GatewayIO = {
  env: process.env,
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

/**
 * Runs `atc-gateway` in the foreground: serves the MCP tools over HTTP for
 * the daemons the registry lists, routing every call to one of them over
 * TCP, until SIGINT or SIGTERM. It never starts or reaches a local daemon.
 * The keyed-request bindings (`gateway.db`) and the authorization server
 * (`mcp-auth.db`) live in the state directory, the only place it writes. A
 * registry that fails to load, or a server that fails to start, prints the
 * reason and exits 1.
 */
export async function runGateway(
  build: string,
  flags: GatewayFlags,
  io: GatewayIO = PROCESS_IO,
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
        io.print(line.replaceAll(/[\p{Cc}\p{Cf}]/gu, ''));
      },

      // Request lines go to stderr, so stdout keeps the approval lines alone.
      printRequest: (line) => {
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
  io.print(`atc-gateway: serving ${server.origin}/mcp, listening on ${server.listening}`);
}
