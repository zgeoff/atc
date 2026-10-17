// atc CLI entry: no subcommand opens the client TUI; `hook-report` and
// `statusline` are the commands injected into wrangled sessions.
import { basename, resolve } from 'node:path';
import { parseListenAddress } from '@atc/config/host';
import type { HostServices } from '@atc/plugin-api';
import { runATCCLI } from './run-atc-cli';
import type { ATCCLIIO } from './run-atc-cli';

// This process's host services, built once, on first use. The reporters
// never use them, so a hook or statusline command starts without loading
// the modules behind them.
let pendingHostServices: Promise<HostServices> | null = null;

// What each command runs in this process, loading its modules only when it
// runs.
const PROCESS_IO: ATCCLIIO = {
  runTUI: async (daemon) => {
    const lifecycle = await import('./build-lifecycle-host');
    const slot = await import('./client/tui-host-slot');
    const hostServices = await resolveHostServices();

    const lifecycleHost = lifecycle.buildLifecycleHost(process.env, hostServices);

    if (daemon === null) {
      const host = await import('./build-tui-host');

      slot.tuiHostSlot.current = host.buildTUIHost(lifecycleHost);
    } else {
      const config = await import('@atc/config');
      const harnessPlugins = await import('./plugins/shipped-harness-plugins');
      const resolved = await import('./resolve-remote-daemon');
      const host = await import('./build-remote-tui-host');

      const picked = resolved.resolveRemoteDaemon(
        config.loadConfig(harnessPlugins.SHIPPED_HARNESS_PLUGINS),
        daemon,
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
  runMCP: async (flags) => {
    const boot = await import('@atc/lifecycle');
    const lifecycle = await import('./build-lifecycle-host');
    const hostServices = await resolveHostServices();

    const host = lifecycle.buildLifecycleHost(process.env, hostServices);

    if (!flags.http) {
      const server = await import('./mcp-server');

      await server.runMCPServer(host.invocation.readBuild(), () => boot.bootDaemonClient(host));

      return;
    }

    const http = await import('./mcp-http-server');
    const database = await import('./open-mcp-auth-database');

    await http.runMCPHTTPServer(
      host.invocation.readBuild(),
      {
        host: flags.host,
        port: flags.port,
        publicURL: flags.publicURL,
        waitForDaemon: flags.waitForDaemon,
      },
      {
        bootDaemon: (options) => boot.bootDaemonClient(host, options),
        openAuthDatabase: database.openMCPAuthDatabase,
      },
    );
  },
  runClients: async (action) => {
    const clients = await import('./clients');
    const config = await import('@atc/config');

    await clients.runClients(action, { dbPath: config.mcpAuthDBFile, command: 'atc clients' });
  },
  runPasskeys: async (action) => {
    const passkeys = await import('./passkeys');
    const config = await import('@atc/config');

    await passkeys.runPasskeys(action, { dbPath: config.mcpAuthDBFile, command: 'atc passkeys' });
  },
  runSession: async (action, id) => {
    const code = await runSessionCommand(action, id);

    process.exit(code);
  },
  runGrants: async (revoke) => {
    const grants = await import('./grants');

    await grants.runGrants(revoke);
  },
  runConfigMigrate: async (file, write) => {
    const migrate = await import('./run-config-migrate');
    const config = await import('@atc/config');

    const code = migrate.runConfigMigrate(file ?? config.configFile, write);

    if (code !== 0) {
      process.exit(code);
    }
  },
  runDaemon: (listen, tokenFile) => runDaemon(listen, tokenFile),
  runDaemonID: async () => {
    const id = await import('@atc/lifecycle');
    const lifecycle = await import('./build-lifecycle-host');
    const hostServices = await resolveHostServices();

    await id.runDaemonID(lifecycle.buildLifecycleHost(process.env, hostServices));
  },
  runDaemonRestart: async (flags) => {
    const options = parseRestartFlags(flags);

    const restart = await import('@atc/lifecycle');
    const lifecycle = await import('./build-lifecycle-host');
    const hostServices = await resolveHostServices();

    const host = lifecycle.buildLifecycleHost(process.env, hostServices);

    const code = await restart.runDaemonRestart(host, { ...options, dryRun: flags.dryRun });

    process.exit(code);
  },
  runDaemonRestartWorker: async (flags) => {
    const options = parseRestartFlags(flags);

    const worker = await import('@atc/lifecycle');
    const lifecycle = await import('./build-lifecycle-host');
    const hostServices = await resolveHostServices();

    const host = lifecycle.buildLifecycleHost(process.env, hostServices);

    const code = await worker.runDaemonRestartWorker(host, {
      ...options,
      runID: flags.runID,
      callerSession: flags.session,
    });

    process.exit(code);
  },
  runBackup: async (path) => {
    const backup = await import('@atc/lifecycle');
    const lifecycle = await import('./build-lifecycle-host');
    const hostServices = await resolveHostServices();

    const code = await backup.runDaemonBackup(
      lifecycle.buildLifecycleHost(process.env, hostServices),
      resolve(path),
    );

    process.exit(code);
  },
  runEvents: async () => {
    const events = await import('./events');

    await events.runEvents();
  },
  printCodexHooks: async () => {
    const hook = await import('@atc/harness-codex');
    const hostServices = await resolveHostServices();

    hook.printCodexHookFile(hostServices.atcArgv);
  },
  printGrokHooks: async () => {
    const hook = await import('@atc/harness-grok');
    const hostServices = await resolveHostServices();

    hook.printGrokHookFile(hostServices.atcArgv);
  },
  runHookReport: async (agent) => {
    const reporter = await import('./hook-report');

    await reporter.runHookReport(agent);
  },
  runTap: async (session, notices) => {
    const tap = await import('./tap');

    await tap.runTap(session, undefined, undefined, notices);
  },
  runNote: async (kind, options) => {
    const note = await import('./note');

    await note.runNote(kind, options);
  },
  runStatusline: async (agent) => {
    const statusline = await import('./statusline');

    await statusline.runStatusline(agent);
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

interface RestartArgs {
  readonly listen: string | null;
  readonly tokenFile: string | null;
  readonly timeout: string | null;
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
function parseRestartFlags(args: RestartArgs): RestartFlags {
  const listen = args.listen;
  const parsedListen = listen === null ? null : parseListenAddress(listen);

  if (parsedListen !== null && !parsedListen.ok) {
    console.error(`atc daemon restart: ${parsedListen.message}`);
    process.exit(1);
  }

  const timeout = args.timeout === null ? null : Number(args.timeout);

  if (timeout !== null && (!Number.isFinite(timeout) || timeout <= 0)) {
    console.error('atc daemon restart: --timeout takes a number of seconds above 0');
    process.exit(1);
  }

  // An explicit token file is read where the caller runs, not in the old
  // daemon's directory, so a relative path is fixed here before the handoff.
  const tokenFile = args.tokenFile === null ? null : resolve(args.tokenFile);

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

  const daemon = await import('@atc/daemon');
  const config = await import('@atc/config');
  const harnessPlugins = await import('./plugins/shipped-harness-plugins');
  const adapterBuilder = await import('./agents/build-agent-adapters');
  const headless = await import('@atc/harness-claude');
  const targets = await import('@atc/daemon');
  const providers = await import('./plugins/build-shipped-execution-provider');
  const sourceOrder = await import('@atc/daemon');
  const builtinSources = await import('./sources/collect-builtin-sources');
  const home = await import('@atc/config/host');
  const sqlite = await import('@atc/store/sqlite');

  // The daemon never opens the gateway's authorization database, by any
  // route, so an open of a file with its name fails in this process.
  sqlite.registerRefusedSQLiteName(basename(config.mcpAuthDBFile));

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

  // The daemon's own lines go to stderr through LogTape, and a stop or a
  // quit stops the log before the process exits.
  const stderrLog = await daemon.startStderrLog();

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
      onQuit: () => {
        void stderrLog.stop().then(() => process.exit(0));
      },
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
      await stderrLog.stop();

      process.exit(0);
    })();
  });
}

await runATCCLI(process.argv.slice(2), PROCESS_IO);
