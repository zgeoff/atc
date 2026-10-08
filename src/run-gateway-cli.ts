import { join } from 'node:path';
import { defineCommand, renderUsage, runCommand } from 'citty';
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
  readonly print: (line: string) => void;
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
 * exits 1 before any subcommand runs. `--help` anywhere prints the usage of
 * the command it follows and exits 0, `--version` alone prints the version,
 * and a command line the parser refuses prints that command's usage and
 * the reason, then exits 1.
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

  const gateway = buildGatewayCommand(parsed.stateDir, io);
  const renderNamedUsage = pickUsage(gateway.usages, argv);

  if (argv.includes('--help') || argv.includes('-h')) {
    const usage = await renderNamedUsage();

    io.print(`${usage}\n`);
    io.exit(0);

    return;
  }

  if (argv.length === 1 && argv[0] === '--version') {
    io.print(pkg.version);

    return;
  }

  try {
    await runCommand(gateway.command, { rawArgs: [...argv] });
  } catch (error) {
    if (isUsageError(error)) {
      const usage = await renderNamedUsage();

      io.print(`${usage}\n`);
    }

    const message = error instanceof Error ? error.message : String(error);

    io.printError(message);
    io.exit(1);
  }
}

/**
 * The usage renderer of the deepest command the command line names: each
 * word past the flags and their values, joined to the ones before it, while
 * the joined name has a usage.
 */
function pickUsage(
  usages: Readonly<Record<string, () => Promise<string>>>,
  argv: readonly string[],
): () => Promise<string> {
  let name = '';
  let index = 0;

  while (index < argv.length) {
    const token = argv[index] ?? '';

    index += 1;

    if (token.startsWith('-')) {
      // A value flag without `=` takes the next token as its value.
      if (!token.includes('=') && GATEWAY_FLAGS.values.has(token.replace(/^-+/u, ''))) {
        index += 1;
      }

      continue;
    }

    const longer = name === '' ? token : `${name} ${token}`;

    if (usages[longer] === undefined) {
      break;
    }

    name = longer;
  }

  return usages[name] ?? usages[''] ?? (() => Promise.resolve(''));
}

// The codes citty gives the errors it throws for a command line it refuses;
// citty exports no error class to test against.
const USAGE_ERROR_CODES: ReadonlySet<string> = new Set([
  'EARG',
  'E_UNKNOWN_COMMAND',
  'E_NO_COMMAND',
]);

function isUsageError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    USAGE_ERROR_CODES.has(error.code)
  );
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

const ROOT_META = {
  name: 'atc-gateway',
  version: pkg.version,
  description: 'Serve the atc MCP tools over HTTP for the daemons a registry lists',
};

const CLIENTS_META = {
  name: 'clients',
  description: 'List, add, or remove the clients that may connect to the gateway',
};

/**
 * The `atc-gateway` command tree, which serves the MCP tools over HTTP for
 * the daemons a registry lists and manages the clients that may connect to
 * it, and the usage of each command in it, keyed by the subcommand names
 * that lead to it. Every subcommand takes the state directory read from
 * the whole command line, or exits 1 without one.
 */
function buildGatewayCommand(stateDir: string | null, io: GatewayCLIIO) {
  const serve = defineCommand({
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
  });

  const list = defineCommand({
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
  });

  const add = defineCommand({
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
        { kind: 'add', name: ctx.args.name, redirectURIs: collectRedirectURIs(ctx.rawArgs) },
        { dbPath: join(stateDir, 'mcp-auth.db'), command: 'atc-gateway clients' },
      );
    },
  });

  const remove = defineCommand({
    meta: { name: 'remove', description: 'Remove a client and revoke every grant it holds' },
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
  });

  const clients = defineCommand({
    meta: CLIENTS_META,
    args: STATE_DIR_ARG,
    default: 'list',
    subCommands: { list, add, remove },
  });

  const command = defineCommand({
    meta: ROOT_META,

    // Declared at every level, so the argument parser reads `--state-dir <dir>`
    // before a subcommand as a flag and its value, not as a subcommand name.
    args: STATE_DIR_ARG,
    subCommands: { serve, clients },
  });

  // Usage names a command after its parent, so each renders under a parent
  // holding only that parent's name.
  return {
    command,
    usages: {
      '': () => renderUsage(command),
      serve: () => renderUsage(serve, { meta: ROOT_META }),
      clients: () => renderUsage(clients, { meta: ROOT_META }),
      'clients list': () => renderUsage(list, { meta: CLIENTS_META }),
      'clients add': () => renderUsage(add, { meta: CLIENTS_META }),
      'clients remove': () => renderUsage(remove, { meta: CLIENTS_META }),
    },
  };
}
