import { join } from 'node:path';
import { define, lazy } from 'gunshi';
import { integer } from 'gunshi/combinators';
import pkg from '../package.json';
import type { runClients } from './clients';
import type { runPasskeys } from './passkeys';
import { makeMissingCommandRun, runCommandLine } from './run-command-line';
import type { CommandLineIO } from './run-command-line';
import type { runGateway } from './run-gateway';

// What the command line reaches outside itself, the process's own by
// default: the subcommands it hands a parsed command to, the console, and
// the exit.
interface GatewayCLIIO extends CommandLineIO {
  readonly runGateway: (...args: Readonly<Parameters<typeof runGateway>>) => Promise<void>;
  readonly runClients: (...args: Readonly<Parameters<typeof runClients>>) => Promise<void>;
  readonly runPasskeys: (...args: Readonly<Parameters<typeof runPasskeys>>) => Promise<void>;
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
  runPasskeys: async (...args) => {
    const passkeys = await import('./passkeys');

    await passkeys.runPasskeys(...args);
  },
  print: (line) => {
    console.log(line);
  },
  printError: (line) => {
    console.error(line);
  },
  exit: (code) => {
    process.exit(code);
  },
};

// The flag every command takes for the directory holding `gateway.db` and
// `mcp-auth.db`. It may repeat, and every value must give the same
// directory.
const STATE_DIR_ARG = {
  'state-dir': {
    type: 'string',
    multiple: true,
    description: 'Directory for gateway.db and mcp-auth.db (default $ATC_GATEWAY_STATE_DIR)',
  },
} as const;

const GATEWAY_DESCRIPTION = 'Serve the atc MCP tools over HTTP for the daemons a registry lists';

export async function runGatewayCLI(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: GatewayCLIIO = PROCESS_IO,
): Promise<void> {
  // Runs a subcommand on the state directory, or prints why there is none
  // and exits 1.
  const withStateDir = async (
    given: readonly string[] | undefined,
    run: (stateDir: string) => Promise<void>,
  ): Promise<void> => {
    const picked = pickStateDir(given ?? [], env);

    if (!picked.ok) {
      io.printError(`atc-gateway: ${picked.message}`);
      io.exit(1);

      return;
    }

    await run(picked.stateDir);
  };

  const serve = lazy(
    () => async (ctx) => {
      await withStateDir(ctx.values['state-dir'], (stateDir) =>
        io.runGateway(`atc-gateway/${pkg.version}`, {
          host: ctx.values.host ?? '127.0.0.1',
          port: ctx.values.port ?? 8414,
          publicURL: ctx.values['public-url'],
          trustForwardedFrom: ctx.values['trust-forwarded-from'] ?? [],
          registryPath: ctx.values.registry,
          stateDir,
        }),
      );
    },
    {
      name: 'serve',
      description: 'Serve MCP over HTTP behind OAuth',
      args: {
        host: { type: 'string', description: 'Address to bind (default 127.0.0.1)' },
        port: integer({
          min: 0,
          max: 65_535,
          description: 'Port to listen on, or 0 for a free one (default 8414)',
        }),
        'public-url': {
          type: 'string',
          required: true,
          description: 'Origin clients reach the gateway at, such as https://mcp.example.com',
        },
        'trust-forwarded-from': {
          type: 'string',
          multiple: true,
          description:
            'A proxy address whose CF-Connecting-IP header security events trust; repeat for more',
        },
        registry: { type: 'string', required: true, description: 'The registry JSON file' },
        ...STATE_DIR_ARG,
      },
    },
  );

  const runClientsList = async (given: readonly string[] | undefined): Promise<void> => {
    await withStateDir(given, (stateDir) =>
      io.runClients({ kind: 'list' }, buildClientsTarget(stateDir)),
    );
  };

  const clients = define({
    name: 'clients',
    description: 'List, add, or remove the clients that may connect to the gateway',
    args: STATE_DIR_ARG,
    subCommands: {
      list: lazy(
        () => async (ctx) => {
          await runClientsList(ctx.values['state-dir']);
        },
        { name: 'list', description: 'List the clients', internal: true, args: STATE_DIR_ARG },
      ),
      add: lazy(
        () => async (ctx) => {
          await withStateDir(ctx.values['state-dir'], (stateDir) =>
            io.runClients(
              { kind: 'add', name: ctx.values.name, redirectURIs: ctx.values['redirect-uri'] },
              buildClientsTarget(stateDir),
            ),
          );
        },
        {
          name: 'add',
          description: 'Add a client and print its client ID',
          args: {
            name: { type: 'positional', description: 'The client name' },
            'redirect-uri': {
              type: 'string',
              multiple: true,
              required: true,
              description: 'A redirect URI the client returns to; repeat for more',
            },
            ...STATE_DIR_ARG,
          },
        },
      ),
      remove: lazy(
        () => async (ctx) => {
          await withStateDir(ctx.values['state-dir'], (stateDir) =>
            io.runClients(
              { kind: 'remove', clientID: ctx.values.id },
              buildClientsTarget(stateDir),
            ),
          );
        },
        {
          name: 'remove',
          description: 'Remove a client and revoke every grant it holds',
          args: { id: { type: 'positional', description: 'The client ID' }, ...STATE_DIR_ARG },
        },
      ),
    },
    run: async (ctx) => {
      await runClientsList(ctx.values['state-dir']);
    },
  });

  const runPasskeysList = async (given: readonly string[] | undefined): Promise<void> => {
    await withStateDir(given, (stateDir) =>
      io.runPasskeys({ kind: 'list' }, buildPasskeysTarget(stateDir)),
    );
  };

  const passkeys = define({
    name: 'passkeys',
    description: 'List, enroll, or remove the passkeys the owner signs in to the gateway with',
    args: STATE_DIR_ARG,
    subCommands: {
      list: lazy(
        () => async (ctx) => {
          await runPasskeysList(ctx.values['state-dir']);
        },
        {
          name: 'list',
          description: 'List the enrolled passkeys',
          internal: true,
          args: STATE_DIR_ARG,
        },
      ),
      enroll: lazy(
        () => async (ctx) => {
          await withStateDir(ctx.values['state-dir'], (stateDir) =>
            io.runPasskeys(
              { kind: 'enroll', reset: ctx.values.reset === true },
              buildPasskeysTarget(stateDir),
            ),
          );
        },
        {
          name: 'enroll',
          description:
            'Print a one-time token that enrolls a passkey; --reset first removes every passkey',
          args: {
            reset: {
              type: 'boolean',
              description: 'Remove every passkey and browser sign-in first, after losing them',
            },
            ...STATE_DIR_ARG,
          },
        },
      ),
      remove: lazy(
        () => async (ctx) => {
          await withStateDir(ctx.values['state-dir'], (stateDir) =>
            io.runPasskeys({ kind: 'remove', id: ctx.values.id }, buildPasskeysTarget(stateDir)),
          );
        },
        {
          name: 'remove',
          description: 'Remove a passkey, such as a lost one',
          args: { id: { type: 'positional', description: 'The passkey ID' }, ...STATE_DIR_ARG },
        },
      ),
    },
    run: async (ctx) => {
      await runPasskeysList(ctx.values['state-dir']);
    },
  });

  const entry = define({
    name: 'atc-gateway',
    description: GATEWAY_DESCRIPTION,
    args: STATE_DIR_ARG,
    run: makeMissingCommandRun(io),
  });

  await runCommandLine(
    argv,
    entry,
    {
      name: 'atc-gateway',
      version: pkg.version,
      description: GATEWAY_DESCRIPTION,
      subCommands: { serve, clients, passkeys },
    },
    io,
  );
}

type PickedStateDir =
  | { readonly ok: true; readonly stateDir: string }
  | { readonly ok: false; readonly message: string };

// The state directory the command line gives, every `--state-dir` alike,
// or `ATC_GATEWAY_STATE_DIR` when it gives none.
function pickStateDir(
  given: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): PickedStateDir {
  if (given.includes('')) {
    return { ok: false, message: '--state-dir needs a value; write --state-dir=<value>' };
  }

  const distinct = [...new Set(given)];

  if (distinct.length > 1) {
    return {
      ok: false,
      message: `--state-dir gives different directories: ${distinct.map((directory) => `'${directory}'`).join(', ')}`,
    };
  }

  const stateDir = distinct[0] ?? env['ATC_GATEWAY_STATE_DIR'] ?? '';

  return stateDir === ''
    ? { ok: false, message: 'give --state-dir or set ATC_GATEWAY_STATE_DIR' }
    : { ok: true, stateDir };
}

// The database and command prefix of every client subcommand.
function buildClientsTarget(stateDir: string) {
  return { dbPath: join(stateDir, 'mcp-auth.db'), command: 'atc-gateway clients' };
}

// The database and command prefix of every passkey subcommand.
function buildPasskeysTarget(stateDir: string) {
  return { dbPath: join(stateDir, 'mcp-auth.db'), command: 'atc-gateway passkeys' };
}
