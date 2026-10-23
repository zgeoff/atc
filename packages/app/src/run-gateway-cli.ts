import { join } from 'node:path';
import { define, lazy } from 'gunshi';
import { integer } from 'gunshi/combinators';
import pkg from '../package.json';
import type { runClients } from './clients';
import { createClientsCommand } from './create-clients-command';
import { createPasskeysCommand } from './create-passkeys-command';
import type { runPasskeys } from './passkeys';
import { PROCESS_IO } from './process-io';
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

const GATEWAY_CLI_IO: GatewayCLIIO = {
  ...PROCESS_IO,
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
  io: GatewayCLIIO = GATEWAY_CLI_IO,
): Promise<void> {
  // Runs a subcommand on the state directory, or prints why there is none
  // and exits 1.
  const withStateDir = async (
    values: Readonly<Record<string, unknown>>,
    run: (stateDir: string) => Promise<void>,
  ): Promise<void> => {
    const given: unknown = values['state-dir'];

    const stateDirs = Array.isArray(given)
      ? given.filter((value: unknown): value is string => typeof value === 'string')
      : [];

    const picked = pickStateDir(stateDirs, env);

    if (!picked.ok) {
      io.printError(`atc-gateway: ${picked.message}`);
      io.exit(1);

      return;
    }

    await run(picked.stateDir);
  };

  const serve = lazy(
    () => async (ctx) => {
      await withStateDir(ctx.values, (stateDir) =>
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

  const clients = createClientsCommand({
    serverName: 'the gateway',
    sharedArgs: STATE_DIR_ARG,
    runClients: (action, values) =>
      withStateDir(values, (stateDir) =>
        io.runClients(action, {
          dbPath: join(stateDir, 'mcp-auth.db'),
          command: 'atc-gateway clients',
        }),
      ),
  });

  const passkeys = createPasskeysCommand({
    serverName: 'the gateway',
    sharedArgs: STATE_DIR_ARG,
    runPasskeys: (action, values) =>
      withStateDir(values, (stateDir) =>
        io.runPasskeys(action, {
          dbPath: join(stateDir, 'mcp-auth.db'),
          command: 'atc-gateway passkeys',
        }),
      ),
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
