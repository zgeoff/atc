import { join } from 'node:path';
import { defineCommand, runMain } from 'citty';
import pkg from '../package.json';
import { collectRedirectURIs } from './collect-redirect-uris';
import { parseGatewayStateDir } from './parse-gateway-state-dir';
import { parsePort } from './parse-port';

// The flag every subcommand takes for the directory holding `gateway.db` and
// `mcp-auth.db`.
const STATE_DIR_ARG = {
  'state-dir': {
    type: 'string',
    description: 'Directory for gateway.db and mcp-auth.db (default $ATC_GATEWAY_STATE_DIR)',
  },
} as const;

// Every flag a subcommand declares, so a flag in any position, or one no
// subcommand declares, is caught before a subcommand runs.
const GATEWAY_FLAGS = {
  values: new Set(['host', 'port', 'public-url', 'registry', 'redirect-uri', 'state-dir']),
  switches: new Set(['help', 'h', 'version']),
};

// The state directory comes from the whole command line, since the argument
// parser hands a subcommand only the arguments after its name.
const parsedStateDir = parseGatewayStateDir(process.argv.slice(2), process.env, GATEWAY_FLAGS);

if (!parsedStateDir.ok) {
  console.error(`atc-gateway: ${parsedStateDir.message}`);
  process.exit(1);
}

const stateDir = parsedStateDir.stateDir;
const NO_STATE_DIR = 'atc-gateway: give --state-dir or set ATC_GATEWAY_STATE_DIR';

// atc-gateway entry: serves the MCP tools over HTTP for the daemons a
// registry lists, and manages the clients that may connect to it. It loads
// nothing that starts a daemon or a session on this machine.
const main = defineCommand({
  meta: {
    name: 'atc-gateway',
    version: pkg.version,
    description: 'Serve the atc MCP tools over HTTP for the daemons a registry lists',
  },

  // Declared at every level, so the argument parser reads `--state-dir <dir>`
  // before a subcommand as a flag and its value, not as a subcommand name.
  args: STATE_DIR_ARG,
  subCommands: {
    serve: () =>
      defineCommand({
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
            console.error(`atc-gateway: ${port.message}`);
            process.exit(1);
          }

          if (stateDir === null) {
            console.error(NO_STATE_DIR);
            process.exit(1);
          }

          const gateway = await import('./run-gateway');

          await gateway.runGateway(`atc-gateway/${pkg.version}`, {
            host: ctx.args.host ?? '127.0.0.1',
            port: port === null ? 8414 : port.port,
            publicURL: ctx.args['public-url'],
            registryPath: ctx.args.registry,
            stateDir,
          });
        },
      }),
    clients: () =>
      defineCommand({
        meta: {
          name: 'clients',
          description: 'List, add, or remove the clients that may connect to the gateway',
        },
        args: STATE_DIR_ARG,
        default: 'list',
        subCommands: {
          list: () =>
            defineCommand({
              meta: { name: 'list', description: 'List the clients', hidden: true },
              args: STATE_DIR_ARG,
              async run() {
                if (stateDir === null) {
                  console.error(NO_STATE_DIR);
                  process.exit(1);
                }

                const clients = await import('./clients');

                await clients.runClients(
                  { kind: 'list' },
                  {
                    dbPath: join(stateDir, 'mcp-auth.db'),
                    command: 'atc-gateway clients',
                  },
                );
              },
            }),
          add: () =>
            defineCommand({
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
                  console.error(NO_STATE_DIR);
                  process.exit(1);
                }

                const clients = await import('./clients');

                await clients.runClients(
                  {
                    kind: 'add',
                    name: ctx.args.name,
                    redirectURIs: collectRedirectURIs(ctx.rawArgs),
                  },
                  {
                    dbPath: join(stateDir, 'mcp-auth.db'),
                    command: 'atc-gateway clients',
                  },
                );
              },
            }),
          remove: () =>
            defineCommand({
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
                  console.error(NO_STATE_DIR);
                  process.exit(1);
                }

                const clients = await import('./clients');

                await clients.runClients(
                  { kind: 'remove', clientID: ctx.args.id },
                  {
                    dbPath: join(stateDir, 'mcp-auth.db'),
                    command: 'atc-gateway clients',
                  },
                );
              },
            }),
        },
      }),
  },
});

await runMain(main);
