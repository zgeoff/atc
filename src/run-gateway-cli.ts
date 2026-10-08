import { join } from 'node:path';
import { defineCommand, runMain } from 'citty';
import pkg from '../package.json';
import type { runClients } from './clients';
import { collectRedirectURIs } from './collect-redirect-uris';
import { parseGatewayStateDir } from './parse-gateway-state-dir';
import { parsePort } from './parse-port';
import type { runGateway } from './run-gateway';

// What the command line reaches outside itself, the process's own by
// default: the subcommands it hands a parsed command to, the console, and
// the exit.
interface GatewayCLIIO {
  readonly runGateway: (...args: Readonly<Parameters<typeof runGateway>>) => Promise<void>;
  readonly runClients: (...args: Readonly<Parameters<typeof runClients>>) => Promise<void>;
  readonly printError: (line: string) => void;
  readonly exit: (code: number) => void;
}

const PROCESS_IO: GatewayCLIIO = {
  runGateway: async (...args) => {
    const gateway = await import('./run-gateway');

    await gateway.runGateway(...args);
  },
  runClients: async (...args) => {
    const clients = await import('./clients');

    await clients.runClients(...args);
  },
  printError: (line) => {
    console.error(line);
  },
  exit: (code) => {
    process.exit(code);
  },
};

// Every flag a subcommand declares, so a flag in any position, or one no
// subcommand declares, is caught before a subcommand runs.
const GATEWAY_FLAGS = {
  values: new Set(['host', 'port', 'public-url', 'registry', 'redirect-uri', 'state-dir']),
  switches: new Set(['help', 'h', 'version']),
};

/**
 * Runs the `atc-gateway` command line: reads the state directory from the
 * whole of it, since the argument parser hands a subcommand only the
 * arguments after its name, then parses the rest and runs the subcommand
 * it names. A state directory that cannot be read prints the reason and
 * exits 1 before any subcommand runs.
 */
export async function runGatewayCLI(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: GatewayCLIIO = PROCESS_IO,
): Promise<void> {
  const parsed = parseGatewayStateDir(argv, env, GATEWAY_FLAGS);

  if (!parsed.ok) {
    io.printError(`atc-gateway: ${parsed.message}`);
    io.exit(1);

    return;
  }

  await runMain(buildGatewayCommand(parsed.stateDir, io), { rawArgs: [...argv] });
}

// The flag every subcommand takes for the directory holding `gateway.db` and
// `mcp-auth.db`.
const STATE_DIR_ARG = {
  'state-dir': {
    type: 'string',
    description: 'Directory for gateway.db and mcp-auth.db (default $ATC_GATEWAY_STATE_DIR)',
  },
} as const;

const NO_STATE_DIR = 'atc-gateway: give --state-dir or set ATC_GATEWAY_STATE_DIR';

/**
 * The `atc-gateway` command tree, which serves the MCP tools over HTTP for
 * the daemons a registry lists and manages the clients that may connect to
 * it. Every subcommand takes the state directory read from the whole
 * command line, or exits 1 without one.
 */
function buildGatewayCommand(stateDir: string | null, io: GatewayCLIIO) {
  return defineCommand({
    meta: {
      name: 'atc-gateway',
      version: pkg.version,
      description: 'Serve the atc MCP tools over HTTP for the daemons a registry lists',
    },

    // Declared at every level, so the argument parser reads `--state-dir <dir>`
    // before a subcommand as a flag and its value, not as a subcommand name.
    args: STATE_DIR_ARG,
    subCommands: {
      serve: defineCommand({
        meta: { name: 'serve', description: 'Serve MCP over HTTP behind OAuth' },
        args: {
          host: { type: 'string', description: 'Address to bind (default 127.0.0.1)' },
          port: { type: 'string', description: 'Port to listen on (default 8414)' },
          'public-url': {
            type: 'string',
            required: true,
            description: 'Origin clients reach the gateway at, such as https://mcp.example.com',
          },
          registry: { type: 'string', required: true, description: 'The registry JSON file' },
          ...STATE_DIR_ARG,
        },
        async run(ctx) {
          const port = ctx.args.port === undefined ? null : parsePort(ctx.args.port);

          if (port !== null && !port.ok) {
            io.printError(`atc-gateway: ${port.message}`);
            io.exit(1);

            return;
          }

          if (stateDir === null) {
            io.printError(NO_STATE_DIR);
            io.exit(1);

            return;
          }

          await io.runGateway(`atc-gateway/${pkg.version}`, {
            host: ctx.args.host ?? '127.0.0.1',
            port: port === null ? 8414 : port.port,
            publicURL: ctx.args['public-url'],
            registryPath: ctx.args.registry,
            stateDir,
          });
        },
      }),
      clients: defineCommand({
        meta: {
          name: 'clients',
          description: 'List, add, or remove the clients that may connect to the gateway',
        },
        args: STATE_DIR_ARG,
        default: 'list',
        subCommands: {
          list: defineCommand({
            meta: { name: 'list', description: 'List the clients', hidden: true },
            args: STATE_DIR_ARG,
            async run() {
              if (stateDir === null) {
                io.printError(NO_STATE_DIR);
                io.exit(1);

                return;
              }

              await io.runClients(
                { kind: 'list' },
                { dbPath: join(stateDir, 'mcp-auth.db'), command: 'atc-gateway clients' },
              );
            },
          }),
          add: defineCommand({
            meta: { name: 'add', description: 'Add a client and print its client ID' },
            args: {
              name: { type: 'positional', required: true, description: 'The client name' },
              'redirect-uri': {
                type: 'string',
                required: true,
                description: 'A redirect URI the client returns to; repeat for more',
              },
              ...STATE_DIR_ARG,
            },
            async run(ctx) {
              if (stateDir === null) {
                io.printError(NO_STATE_DIR);
                io.exit(1);

                return;
              }

              await io.runClients(
                {
                  kind: 'add',
                  name: ctx.args.name,
                  redirectURIs: collectRedirectURIs(ctx.rawArgs),
                },
                { dbPath: join(stateDir, 'mcp-auth.db'), command: 'atc-gateway clients' },
              );
            },
          }),
          remove: defineCommand({
            meta: {
              name: 'remove',
              description: 'Remove a client and revoke every grant it holds',
            },
            args: {
              id: { type: 'positional', required: true, description: 'The client ID' },
              ...STATE_DIR_ARG,
            },
            async run(ctx) {
              if (stateDir === null) {
                io.printError(NO_STATE_DIR);
                io.exit(1);

                return;
              }

              await io.runClients(
                { kind: 'remove', clientID: ctx.args.id },
                { dbPath: join(stateDir, 'mcp-auth.db'), command: 'atc-gateway clients' },
              );
            },
          }),
        },
      }),
    },
  });
}
