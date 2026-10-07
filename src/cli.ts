// atc CLI entry: no subcommand opens the client TUI; `hook-report` and
// `statusline` are the commands injected into wrangled sessions.
import { resolve } from 'node:path';
import { defineCommand, runMain } from 'citty';
import pkg from '../package.json';
import { collectRedirectURIs } from './collect-redirect-uris';
import { parseListenAddress } from './daemon/parse-listen-address';
import { normalizeCLIArgs } from './normalize-cli-args';
import { parsePort } from './parse-port';
import { getBuild } from './shared/get-build';

// The flags `atc daemon` takes.
const DAEMON_ARGS = {
  listen: {
    type: 'string',
    description: 'Serve the client protocol on <host>:<port> too, a loopback or tailnet address',
  },
  'token-file': {
    type: 'string',
    description: 'File holding the one or two bearer tokens a --listen handshake must present',
  },
} as const;

const main = defineCommand({
  meta: {
    name: 'atc',
    version: pkg.version,
    description: 'Terminal control tower for coding-agent sessions',
  },
  default: 'tui',
  subCommands: {
    tui: () =>
      defineCommand({
        meta: {
          name: 'tui',
          description: 'Open the session list client',
          hidden: true,
        },
        async run() {
          await import('./client/index');
        },
      }),
    mcp: () =>
      defineCommand({
        meta: {
          name: 'mcp',
          description:
            'Run an MCP server exposing the fleet as tools: over stdio, or with --http behind OAuth',
        },
        args: {
          http: {
            type: 'boolean',
            default: false,
            description: 'Serve MCP over HTTP behind OAuth',
          },
          host: {
            type: 'string',
            description: 'Address to bind with --http (default 127.0.0.1)',
          },
          port: { type: 'string', description: 'Port to listen on with --http (default 8414)' },
          'public-url': {
            type: 'string',
            description:
              'Origin clients reach the --http server at, such as https://mcp.example.com',
          },
          'wait-for-daemon': {
            type: 'boolean',
            default: false,
            description:
              'With --http, wait for a running daemon instead of starting one, for a managed daemon',
          },
        },
        async run(ctx) {
          if (!ctx.args.http) {
            const server = await import('./mcp-server');

            await server.runMCPServer(getBuild());

            return;
          }

          const port = ctx.args.port === undefined ? null : parsePort(ctx.args.port);

          if (port !== null && !port.ok) {
            console.error(`atc mcp --http: ${port.message}`);
            process.exit(1);
          }

          const http = await import('./mcp-http-server');

          await http.runMCPHTTPServer(getBuild(), {
            host: ctx.args.host ?? null,
            port: port === null ? null : port.port,
            publicURL: ctx.args['public-url'] ?? null,
            waitForDaemon: ctx.args['wait-for-daemon'],
          });
        },
      }),
    clients: () =>
      defineCommand({
        meta: {
          name: 'clients',
          description: 'List, add, or remove the clients that may connect to atc mcp --http',
        },
        default: 'list',
        subCommands: {
          list: () =>
            defineCommand({
              meta: { name: 'list', description: 'List the clients', hidden: true },
              async run() {
                const clients = await import('./clients');
                const config = await import('./shared/config');

                await clients.runClients(
                  { kind: 'list' },
                  { dbPath: config.mcpAuthDBFile, command: 'atc clients' },
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
              },
              async run(ctx) {
                const clients = await import('./clients');
                const config = await import('./shared/config');

                await clients.runClients(
                  {
                    kind: 'add',
                    name: ctx.args.name,
                    redirectURIs: collectRedirectURIs(ctx.rawArgs),
                  },
                  { dbPath: config.mcpAuthDBFile, command: 'atc clients' },
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
              },
              async run(ctx) {
                const clients = await import('./clients');
                const config = await import('./shared/config');

                await clients.runClients(
                  { kind: 'remove', clientID: ctx.args.id },
                  { dbPath: config.mcpAuthDBFile, command: 'atc clients' },
                );
              },
            }),
        },
      }),
    grants: () =>
      defineCommand({
        meta: {
          name: 'grants',
          description:
            'List the grants atc mcp --http clients hold, or revoke one with --revoke=<id>',
        },
        args: {
          revoke: { type: 'string', description: 'The ID of a grant to revoke' },
        },
        async run(ctx) {
          const grants = await import('./grants');

          await grants.runGrants(ctx.args.revoke ?? null);
        },
      }),
    config: () =>
      defineCommand({
        meta: { name: 'config', description: "Work on atc's config.json" },
        subCommands: {
          migrate: () =>
            defineCommand({
              meta: {
                name: 'migrate',
                description:
                  'Move the old agent keys of config.json into agents: print the result, or rewrite the file with --write',
              },
              args: {
                write: {
                  type: 'boolean',
                  default: false,
                  description: 'Back the file up beside itself, then rewrite it in place',
                },
                file: {
                  type: 'string',
                  description: 'The config file to migrate (default ~/.config/atc/config.json)',
                },
              },
              async run(ctx) {
                const migrate = await import('./run-config-migrate');
                const config = await import('./shared/config');

                const code = migrate.runConfigMigrate(
                  ctx.args.file ?? config.configFile,
                  ctx.args.write,
                );

                if (code !== 0) {
                  process.exit(code);
                }
              },
            }),
        },
      }),
    daemon: () =>
      defineCommand({
        meta: {
          name: 'daemon',
          description: 'Run the atc daemon in the foreground',
        },

        // Declared here as well as on `serve`, so the parser skips their
        // values when it looks for a subcommand name.
        args: DAEMON_ARGS,
        default: 'serve',
        subCommands: {
          serve: () =>
            defineCommand({
              meta: {
                name: 'serve',
                description: 'Run the atc daemon in the foreground',
                hidden: true,
              },
              args: DAEMON_ARGS,
              async run(ctx) {
                await runDaemon(ctx.args.listen ?? null, ctx.args['token-file'] ?? null);
              },
            }),
          id: () =>
            defineCommand({
              meta: {
                name: 'id',
                description: "Print the running daemon's daemonID",
              },
              async run() {
                const id = await import('./run-daemon-id');

                await id.runDaemonID(getBuild());
              },
            }),
          restart: () =>
            defineCommand({
              meta: {
                name: 'restart',
                description: 'Restart the running daemon and restore its fleet',
              },
              args: {
                ...DAEMON_ARGS,
                timeout: {
                  type: 'string',
                  description: 'Seconds to wait for the restored fleet to come alive',
                },
                'dry-run': {
                  type: 'boolean',
                  default: false,
                  description: 'Print what the restart would do and stop',
                },
              },
              async run(ctx) {
                const options = parseRestartArgs(ctx.args);

                const restart = await import('./run-daemon-restart');

                const code = await restart.runDaemonRestart({
                  ...options,
                  dryRun: ctx.args['dry-run'],
                });

                process.exit(code);
              },
            }),
          'restart-worker': () =>
            defineCommand({
              meta: {
                name: 'restart-worker',
                description: 'Run one daemon restart for atc daemon restart',
                hidden: true,
              },
              args: {
                ...DAEMON_ARGS,
                runID: { type: 'positional', required: true, description: 'The run id' },
                session: { type: 'string', description: 'The session that asked for the restart' },
                timeout: { type: 'string', description: 'Seconds to wait for the restored fleet' },
              },
              async run(ctx) {
                const options = parseRestartArgs(ctx.args);

                const worker = await import('./run-daemon-restart-worker');

                const code = await worker.runDaemonRestartWorker({
                  ...options,
                  runID: ctx.args.runID,
                  callerSession: ctx.args.session ?? null,
                });

                process.exit(code);
              },
            }),
        },
      }),
    events: () =>
      defineCommand({
        meta: {
          name: 'events',
          description: 'Stream daemon wire events to stdout as NDJSON',
        },
        async run() {
          const events = await import('./events');

          await events.runEvents();
        },
      }),
    'codex-hooks': () =>
      defineCommand({
        meta: {
          name: 'codex-hooks',
          description:
            'Print the Codex hook entries to merge into $CODEX_HOME/hooks.json (trust them once in the Codex TUI)',
        },
        async run() {
          const hook = await import('./agents/print-codex-hook-file');

          hook.printCodexHookFile();
        },
      }),
    'grok-hooks': () =>
      defineCommand({
        meta: {
          name: 'grok-hooks',
          description: 'Print the Grok hook file to install at $GROK_HOME/hooks/atc-reporter.json',
        },
        async run() {
          const hook = await import('./agents/print-grok-hook-file');

          hook.printGrokHookFile();
        },
      }),
    'hook-report': () =>
      defineCommand({
        meta: {
          name: 'hook-report',
          description: 'Forward a hook event from a wrangled session to the atc socket',
          hidden: true,
        },

        // No arg is required: a citty usage error exits nonzero, and
        // reporters must always exit 0.
        args: {
          agent: { type: 'string', default: '' },
        },
        async run(ctx) {
          const reporter = await import('./hook-report');

          await reporter.runHookReport(ctx.args.agent);
        },
      }),
    tap: () =>
      defineCommand({
        meta: {
          name: 'tap',
          description: "Stream a session's inbox to stdout as NDJSON, acking each message",
        },
        args: {
          session: {
            type: 'string',
            required: true,
            description: 'The atc session id to tap',
          },
        },
        async run(ctx) {
          const tap = await import('./tap');

          await tap.runTap(ctx.args.session);
        },
      }),
    report: () =>
      defineCommand({
        meta: {
          name: 'report',
          description:
            'Report a message answer or a note from a wrangled session to the atc socket',
          hidden: true,
        },

        // No arg is required: a citty usage error exits nonzero, and
        // reporters must always exit 0.
        args: {
          kind: { type: 'positional', required: false, default: '' },
          message: { type: 'string', default: '' },
          label: { type: 'string', default: '' },
          messages: { type: 'string', default: '' },
          turn: { type: 'string', default: '' },
        },
        async run(ctx) {
          const reporter = await import('./report');

          await reporter.runReport(ctx.args.kind, {
            message: ctx.args.message,
            messages: ctx.args.messages,
            label: ctx.args.label,
            turn: ctx.args.turn,
          });
        },
      }),
    statusline: () =>
      defineCommand({
        meta: {
          name: 'statusline',
          description: 'Render the chained statusline for a wrangled session',
          hidden: true,
        },

        // A statusline command must always exit 0 too, so no arg is required.
        args: {
          agent: { type: 'string', default: '' },
        },
        async run(ctx) {
          const statusline = await import('./statusline');

          await statusline.runStatusline(ctx.args.agent);
        },
      }),
  },
});

interface RestartArgs {
  readonly listen?: string | undefined;
  readonly 'token-file'?: string | undefined;
  readonly timeout?: string | undefined;
}

interface RestartFlags {
  readonly listen: string | null;
  readonly tokenFile: string | null;
  readonly timeoutSeconds: number | null;
}

// Reads the flags the restart commands share, and stops the command on one
// the replacement daemon would refuse after the old one is already gone.
function parseRestartArgs(args: RestartArgs): RestartFlags {
  const listen = args.listen ?? null;
  const parsedListen = listen === null ? null : parseListenAddress(listen);

  if (parsedListen !== null && !parsedListen.ok) {
    console.error(`atc daemon restart: ${parsedListen.message}`);
    process.exit(1);
  }

  const timeout = args.timeout === undefined ? null : Number(args.timeout);

  if (timeout !== null && (!Number.isFinite(timeout) || timeout <= 0)) {
    console.error('atc daemon restart: --timeout takes a number of seconds above 0');
    process.exit(1);
  }

  // An explicit token file is read where the caller runs, not in the old
  // daemon's directory, so a relative path is fixed here before the handoff.
  const tokenFile = args['token-file'] === undefined ? null : resolve(args['token-file']);

  return { listen, tokenFile, timeoutSeconds: timeout };
}

// Runs the daemon in the foreground until SIGTERM, with a TCP listener when
// --listen and --token-file are given.
async function runDaemon(listenArg: string | null, tokenFile: string | null): Promise<void> {
  if ((listenArg === null) !== (tokenFile === null)) {
    console.error('atc daemon: --listen and --token-file go together');
    process.exit(1);
  }

  const listen = listenArg === null ? null : parseListenAddress(listenArg);

  if (listen !== null && !listen.ok) {
    console.error(`atc daemon: ${listen.message}`);
    process.exit(1);
  }

  const daemon = await import('./daemon/daemon');
  const config = await import('./shared/config');
  const adapterBuilder = await import('./agents/build-agent-adapters');
  const headless = await import('./agents/start-claude-headless-run');
  const targets = await import('./daemon/build-execution-targets');
  const sourceOrder = await import('./sources/build-sources');
  const builtinSources = await import('./sources/collect-builtin-sources');
  const zoxide = await import('./shared/collect-zoxide-dirs');
  const home = await import('./shared/resolve-home-dir');

  // Test harnesses shrink the outbound queue to force overflow
  // deterministically; unset means the production default.
  const queueBytes = Number(process.env['ATC_QUEUE_BYTES']);
  const cfg = config.loadConfig();
  const built = targets.buildExecutionTargets(cfg.targets);
  const targetErrors = [...cfg.targetErrors, ...built.errors];

  for (const error of targetErrors) {
    const line =
      error.scope === 'config'
        ? `${error.path} cannot be used (${error.problem}: ${error.detail}); every spawn is refused, local ones included, until it is fixed`
        : error.problem;

    console.error(`atc daemon: config: ${line}`);
  }

  for (const problem of [
    ...cfg.principalErrors,
    ...cfg.workspaceErrors,
    ...cfg.authProfileErrors,
    ...cfg.agentErrors,
  ]) {
    console.error(`atc daemon: config: ${problem}`);
  }

  if (cfg.legacyAgentKeys.length > 0) {
    console.error(
      `atc daemon: config: config.json uses the old agent keys (${cfg.legacyAgentKeys.join(', ')}); run 'atc config migrate' to move them into agents`,
    );
  }

  if (cfg.removedKeys.length > 0) {
    console.error(
      `atc daemon: config: config.json sets ${cfg.removedKeys.join(', ')}, which atc no longer reads; run 'atc config migrate' to drop it`,
    );
  }

  const sources = sourceOrder.buildSources(
    builtinSources.collectBuiltinSources({
      roots: cfg.dirs.roots,
      githubOwner: cfg.workspaces.githubOwner,
      ghBin: 'gh',
      homeDir: home.resolveHomeDir(),
      collectZoxideDirs: zoxide.collectZoxideDirs,
    }),
    cfg.workspaces.sources,
  );

  for (const id of sources.missing) {
    console.error(
      `atc daemon: config: workspaces.sources holds '${id}', which this daemon cannot offer; the picker leaves it out`,
    );
  }

  // Cap on how long a fleet restore waits for one revived session to
  // report it has booted before moving to the next. Tests pin it to
  // keep timing deterministic; unset means the production default.
  const capOverride = Number(process.env['ATC_RESTORE_BOOT_TIMEOUT_MS']);

  const restoreBootTimeoutMs =
    Number.isFinite(capOverride) && capOverride >= 0 ? capOverride : 15_000;

  // How long a started session may go without a tap before a message
  // to it is refused. Tests pin it to 0 to reach the refusal at once.
  const graceOverride = Number(process.env['ATC_TAP_GRACE_MS']);
  const adapters = adapterBuilder.buildAgentAdapters(cfg, headless.startClaudeHeadlessRun);
  let handle: Awaited<ReturnType<typeof daemon.startDaemon>>;

  try {
    handle = await daemon.startDaemon({
      socketPath: config.daemonSocketPath,
      reporterSocketPath: config.socketPath,
      eventsSocketPath: config.eventsSocketPath,
      build: getBuild(),
      adapters,
      defaultAgent: cfg.defaultAgent,
      dbPath: config.dbFile,
      legacyFleetPath: config.legacyFleetFile,
      pidPath: config.daemonPidFile,
      hooks: cfg.hooks,
      targets: built.targets,
      defaultTarget: cfg.defaultTarget,
      targetErrors,
      principals: cfg.principals,
      sources: sources.sources,
      gitTransports: cfg.workspaces.gitTransports,
      workspaceRoots: { root: cfg.workspaces.root, targetRoots: cfg.workspaces.targetRoots },
      ...(listen === null || tokenFile === null
        ? {}
        : { listen: { host: listen.host, port: listen.port, tokenFile } }),
      restoreBootTimeoutMs,
      restoreFleetOnRestart: cfg.restoreFleetOnRestart,
      ...(Number.isFinite(graceOverride) && graceOverride >= 0
        ? { tapGraceMs: graceOverride }
        : {}),
      ...(Number.isFinite(queueBytes) && queueBytes > 0 ? { queueBytes } : {}),
      onQuit: () => process.exit(0),
    });
  } catch (error) {
    // A second daemon on the same state directory, or a listener whose
    // address or token file is refused or whose bind fails, stops the start
    // with nothing left held; any other startup failure stays a crash.
    const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : null;

    if (error instanceof Error && (code === 'daemon_locked' || code === 'listen_refused')) {
      console.error(error.message);
      process.exit(1);
    }

    throw error;
  }

  process.on('SIGHUP', () => {
    handle.refreshTokens();
  });

  process.on('SIGTERM', () => {
    void (async () => {
      await handle.stop();

      process.exit(0);
    })();
  });
}

await runMain(main, { rawArgs: normalizeCLIArgs(process.argv.slice(2)) });
