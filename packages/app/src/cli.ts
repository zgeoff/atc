// atc CLI entry: no subcommand opens the client TUI; `hook-report` and
// `statusline` are the commands injected into wrangled sessions.
import { resolve } from 'node:path';
import { parseListenAddress } from '@atc/config/host';
import type { HostServices } from '@atc/plugin-api';
import { defineCommand, runMain } from 'citty';
import pkg from '../package.json';
import { collectRedirectURIs } from './collect-redirect-uris';
import { normalizeCLIArgs } from './normalize-cli-args';
import { parsePort } from './parse-port';

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

// This process's host services, built once, on first use. The reporters
// never use them, so a hook or statusline command starts without loading
// the modules behind them.
let pendingHostServices: Promise<HostServices> | null = null;

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
        args: {
          daemon: {
            type: 'string',
            description:
              "Connect to this daemon from the config's daemons map instead of the local daemon",
          },
        },
        async run(ctx) {
          const lifecycle = await import('./build-lifecycle-host');
          const slot = await import('./client/tui-host-slot');
          const hostServices = await resolveHostServices();

          const lifecycleHost = lifecycle.buildLifecycleHost(process.env, hostServices);

          if (ctx.args.daemon === undefined) {
            const host = await import('./build-tui-host');

            slot.tuiHostSlot.current = host.buildTUIHost(lifecycleHost);
          } else {
            const config = await import('@atc/config');
            const harnessPlugins = await import('./plugins/shipped-harness-plugins');
            const resolved = await import('./resolve-remote-daemon');
            const host = await import('./build-remote-tui-host');

            const picked = resolved.resolveRemoteDaemon(
              config.loadConfig(harnessPlugins.SHIPPED_HARNESS_PLUGINS),
              ctx.args.daemon,
              config.configFile,
            );

            if (!picked.ok) {
              console.error(`atc: ${picked.message}`);
              process.exit(1);
            }

            slot.tuiHostSlot.current = host.buildRemoteTUIHost(lifecycleHost, picked.daemon);
          }

          await import('./client');
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
          port: {
            type: 'string',
            description: 'Port to listen on with --http, or 0 for a free one (default 8414)',
          },
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
          const boot = await import('@atc/lifecycle');
          const lifecycle = await import('./build-lifecycle-host');
          const hostServices = await resolveHostServices();

          const host = lifecycle.buildLifecycleHost(process.env, hostServices);

          if (!ctx.args.http) {
            const server = await import('./mcp-server');

            await server.runMCPServer(host.invocation.readBuild(), () =>
              boot.bootDaemonClient(host),
            );

            return;
          }

          const port = ctx.args.port === undefined ? null : parsePort(ctx.args.port);

          if (port !== null && !port.ok) {
            console.error(`atc mcp --http: ${port.message}`);
            process.exit(1);
          }

          const http = await import('./mcp-http-server');
          const database = await import('./open-mcp-auth-database');

          await http.runMCPHTTPServer(
            host.invocation.readBuild(),
            {
              host: ctx.args.host ?? null,
              port: port === null ? null : port.port,
              publicURL: ctx.args['public-url'] ?? null,
              waitForDaemon: ctx.args['wait-for-daemon'],
            },
            {
              bootDaemon: (options) => boot.bootDaemonClient(host, options),
              openAuthDatabase: database.openMCPAuthDatabase,
            },
          );
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
                const config = await import('@atc/config');

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
                const config = await import('@atc/config');

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
                const config = await import('@atc/config');

                await clients.runClients(
                  { kind: 'remove', clientID: ctx.args.id },
                  { dbPath: config.mcpAuthDBFile, command: 'atc clients' },
                );
              },
            }),
        },
      }),
    passkeys: () =>
      defineCommand({
        meta: {
          name: 'passkeys',
          description:
            'List, enroll, or remove the passkeys the owner signs in to atc mcp --http with',
        },
        default: 'list',
        subCommands: {
          list: () =>
            defineCommand({
              meta: { name: 'list', description: 'List the enrolled passkeys', hidden: true },
              async run() {
                const passkeys = await import('./passkeys');
                const config = await import('@atc/config');

                await passkeys.runPasskeys(
                  { kind: 'list' },
                  { dbPath: config.mcpAuthDBFile, command: 'atc passkeys' },
                );
              },
            }),
          enroll: () =>
            defineCommand({
              meta: {
                name: 'enroll',
                description:
                  'Print a one-time token that enrolls a passkey; --reset first removes every passkey',
              },
              args: {
                reset: {
                  type: 'boolean',
                  description: 'Remove every passkey and browser sign-in first, after losing them',
                },
              },
              async run(ctx) {
                const passkeys = await import('./passkeys');
                const config = await import('@atc/config');

                await passkeys.runPasskeys(
                  { kind: 'enroll', reset: ctx.args.reset === true },
                  { dbPath: config.mcpAuthDBFile, command: 'atc passkeys' },
                );
              },
            }),
          remove: () =>
            defineCommand({
              meta: { name: 'remove', description: 'Remove a passkey, such as a lost one' },
              args: {
                id: { type: 'positional', required: true, description: 'The passkey ID' },
              },
              async run(ctx) {
                const passkeys = await import('./passkeys');
                const config = await import('@atc/config');

                await passkeys.runPasskeys(
                  { kind: 'remove', id: ctx.args.id },
                  { dbPath: config.mcpAuthDBFile, command: 'atc passkeys' },
                );
              },
            }),
        },
      }),
    session: () =>
      defineCommand({
        meta: {
          name: 'session',
          description: "Rebind a session's host or start its terminal, as the daemon's owner",
        },
        subCommands: {
          rebind: () =>
            defineCommand({
              meta: {
                name: 'rebind',
                description:
                  "Bind a session's host to its agent's current auth profiles; then adopt it",
              },
              args: {
                id: { type: 'positional', required: true, description: 'The atc session id' },
              },
              async run(ctx) {
                const code = await runSessionCommand('rebind', ctx.args.id);

                process.exit(code);
              },
            }),
          adopt: () =>
            defineCommand({
              meta: {
                name: 'adopt',
                description: 'Start a terminal for a session that has none, resuming its agent',
              },
              args: {
                id: { type: 'positional', required: true, description: 'The atc session id' },
              },
              async run(ctx) {
                const code = await runSessionCommand('adopt', ctx.args.id);

                process.exit(code);
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
                const config = await import('@atc/config');

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
                const id = await import('@atc/lifecycle');
                const lifecycle = await import('./build-lifecycle-host');
                const hostServices = await resolveHostServices();

                await id.runDaemonID(lifecycle.buildLifecycleHost(process.env, hostServices));
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

                const restart = await import('@atc/lifecycle');
                const lifecycle = await import('./build-lifecycle-host');
                const hostServices = await resolveHostServices();

                const host = lifecycle.buildLifecycleHost(process.env, hostServices);

                const code = await restart.runDaemonRestart(host, {
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

                const worker = await import('@atc/lifecycle');
                const lifecycle = await import('./build-lifecycle-host');
                const hostServices = await resolveHostServices();

                const host = lifecycle.buildLifecycleHost(process.env, hostServices);

                const code = await worker.runDaemonRestartWorker(host, {
                  ...options,
                  runID: ctx.args.runID,
                  callerSession: ctx.args.session ?? null,
                });

                process.exit(code);
              },
            }),
        },
      }),
    backup: () =>
      defineCommand({
        meta: {
          name: 'backup',
          description: "Write a consistent copy of the running daemon's state database to a file",
        },
        args: {
          path: {
            type: 'positional',
            required: true,
            description: 'The file to write, replacing any file there',
          },
        },
        async run(ctx) {
          const backup = await import('@atc/lifecycle');
          const lifecycle = await import('./build-lifecycle-host');
          const hostServices = await resolveHostServices();

          const code = await backup.runDaemonBackup(
            lifecycle.buildLifecycleHost(process.env, hostServices),
            resolve(ctx.args.path),
          );

          process.exit(code);
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
          const hook = await import('@atc/harness-codex');
          const hostServices = await resolveHostServices();

          hook.printCodexHookFile(hostServices.atcArgv);
        },
      }),
    'grok-hooks': () =>
      defineCommand({
        meta: {
          name: 'grok-hooks',
          description: 'Print the Grok hook file to install at $GROK_HOME/hooks/atc-reporter.json',
        },
        async run() {
          const hook = await import('@atc/harness-grok');
          const hostServices = await resolveHostServices();

          hook.printGrokHookFile(hostServices.atcArgv);
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
          notices: {
            type: 'boolean',
            default: false,
            description: 'Also stream the answer notices of the messages the session sent',
          },
        },
        async run(ctx) {
          const tap = await import('./tap');

          await tap.runTap(ctx.args.session, undefined, undefined, ctx.args.notices);
        },
      }),
    note: () =>
      defineCommand({
        meta: {
          name: 'note',
          description: 'Send a note from a wrangled session to the atc socket',
          hidden: true,
        },

        // No arg is required: a citty usage error exits nonzero, and
        // reporters must always exit 0.
        args: {
          label: { type: 'string', default: '' },
        },
        async run(ctx) {
          const note = await import('./note');

          await note.runNote('note', {
            message: '',
            messages: '',
            label: ctx.args.label,
            turn: '',
          });
        },
      }),
    answer: () =>
      defineCommand({
        meta: {
          name: 'answer',
          description: 'Record the answer of a turn for the messages it answered',
          hidden: true,
        },

        // No arg is required: a citty usage error exits nonzero, and
        // reporters must always exit 0.
        args: {
          message: { type: 'string', default: '' },
          messages: { type: 'string', default: '' },
          turn: { type: 'string', default: '' },
        },
        async run(ctx) {
          const note = await import('./note');

          await note.runNote('answered', {
            message: ctx.args.message,
            messages: ctx.args.messages,
            label: '',
            turn: ctx.args.turn,
          });
        },
      }),
    unanswered: () =>
      defineCommand({
        meta: {
          name: 'unanswered',
          description: 'Record that the turn carrying some messages ended without an answer',
          hidden: true,
        },

        // No arg is required: a citty usage error exits nonzero, and
        // reporters must always exit 0.
        args: {
          messages: { type: 'string', default: '' },
          turn: { type: 'string', default: '' },
          reason: { type: 'string', default: '' },
        },
        async run(ctx) {
          const note = await import('./note');

          await note.runNote('unanswered', {
            message: '',
            messages: ctx.args.messages,
            label: '',
            turn: ctx.args.turn,
            reason: ctx.args.reason,
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

// This process's host services: the first call loads and builds them, and
// every later call returns the same ones.
function resolveHostServices(): Promise<HostServices> {
  pendingHostServices ??= loadHostServices();

  return pendingHostServices;
}

async function loadHostServices(): Promise<HostServices> {
  const services = await import('./build-host-services');

  return services.buildHostServices();
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

// Runs one `atc session` action on the daemon, booting it when none
// answers, at this terminal's size, and resolves to the exit code.
async function runSessionCommand(action: 'rebind' | 'adopt', id: string): Promise<number> {
  const boot = await import('@atc/lifecycle');
  const lifecycle = await import('./build-lifecycle-host');
  const sessionAction = await import('./run-session-action');
  const hostServices = await resolveHostServices();

  const booted = await boot.bootDaemonClient(
    lifecycle.buildLifecycleHost(process.env, hostServices),
  );

  const code = await sessionAction.runSessionAction(booted.client, action, id, {
    cols: process.stdout.columns ?? 100,
    rows: process.stdout.rows ?? 30,
  });

  booted.client.stop();

  return code;
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
  const config = await import('@atc/config');
  const harnessPlugins = await import('./plugins/shipped-harness-plugins');
  const adapterBuilder = await import('./agents/build-agent-adapters');
  const headless = await import('@atc/harness-claude');
  const targets = await import('./daemon/build-execution-targets');
  const providers = await import('./plugins/build-shipped-execution-provider');
  const sourceOrder = await import('./sources/build-sources');
  const builtinSources = await import('./sources/collect-builtin-sources');
  const home = await import('@atc/config/host');
  const hostServices = await resolveHostServices();

  // Test harnesses shrink the outbound queue to force overflow
  // deterministically; unset means the production default.
  const queueBytes = Number(process.env['ATC_QUEUE_BYTES']);
  const cfg = config.loadConfig(harnessPlugins.SHIPPED_HARNESS_PLUGINS);

  const built = targets.buildExecutionTargets(cfg.targets, (target) =>
    providers.buildShippedExecutionProvider(target, hostServices, process.env),
  );

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
      host: hostServices,
    }),
    cfg.workspaces.sources,
  );

  for (const id of sources.missing) {
    console.error(
      `atc daemon: config: workspaces.sources holds '${id}', which this daemon cannot offer; the picker leaves it out`,
    );
  }

  // How long a started session may go without a tap before a message
  // to it is refused. Tests pin it to 0 to reach the refusal at once.
  const graceOverride = Number(process.env['ATC_TAP_GRACE_MS']);

  const adapters = adapterBuilder.buildAgentAdapters(
    cfg,
    hostServices,
    headless.startClaudeHeadlessRun,
  );

  let handle: Awaited<ReturnType<typeof daemon.startDaemon>>;

  try {
    handle = await daemon.startDaemon({
      socketPath: config.daemonSocketPath,
      reporterSocketPath: config.socketPath,
      eventsSocketPath: config.eventsSocketPath,
      build: hostServices.build,
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
