import { join } from 'node:path';
import { defineCommand, runMain } from 'citty';
import pkg from '../package.json';
import { collectRedirectURIs } from './collect-redirect-uris';
import { parsePort } from './parse-port';

// The flag every subcommand takes for the directory holding `gateway.db` and
// `mcp-auth.db`.
const STATE_DIR_ARG = {
  'state-dir': {
    type: 'string',
    description: 'Directory for gateway.db and mcp-auth.db (default $ATC_GATEWAY_STATE_DIR)',
  },
} as const;

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

          const stateDir = findStateDir(ctx.args['state-dir'], process.env);

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

        // Declared here too, so `clients --state-dir <dir>` reads `<dir>` as
        // the flag's value rather than a subcommand name.
        args: STATE_DIR_ARG,
        default: 'list',
        subCommands: {
          list: () =>
            defineCommand({
              meta: { name: 'list', description: 'List the clients', hidden: true },
              args: STATE_DIR_ARG,
              async run(ctx) {
                const stateDir = findStateDir(ctx.args['state-dir'], process.env);

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
                const stateDir = findStateDir(ctx.args['state-dir'], process.env);

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
                const stateDir = findStateDir(ctx.args['state-dir'], process.env);

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

// `--state-dir`, else `$ATC_GATEWAY_STATE_DIR`, else null: the gateway has
// no default, so it never writes under a home directory.
function findStateDir(
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const dir = flag ?? env['ATC_GATEWAY_STATE_DIR'];

  return dir === undefined || dir === '' ? null : dir;
}

await runMain(main);
