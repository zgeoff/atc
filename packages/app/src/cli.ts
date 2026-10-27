// atc CLI entry: no subcommand opens the client TUI; `hook-report` and
// `statusline` are the commands injected into wrangled sessions.
import { resolve } from 'node:path';
import { parseListenAddress } from '@atc/config/host';
import type { HostServices } from '@atc/plugin-api';
import { PROCESS_IO } from './process-io';
import { runATCCLI } from './run-atc-cli';
import type { ATCCLIIO } from './run-atc-cli';

// This process's host services, built once, on first use. The reporters
// never use them, so a hook or statusline command starts without loading
// the modules behind them.
let pendingHostServices: Promise<HostServices> | null = null;

// What each command runs in this process, loading its modules only when it
// runs.
const ATC_CLI_IO: ATCCLIIO = {
  ...PROCESS_IO,
  runTUI: async (daemon) => {
    const lifecycle = await import('./build-lifecycle-host');
    const tui = await import('@atc/tui');
    const hostServices = await resolveHostServices();

    const lifecycleHost = lifecycle.buildLifecycleHost(process.env, hostServices);

    if (daemon === null) {
      const host = await import('./create-tui-host');

      await tui.runTUI(host.createTUIHost(lifecycleHost));
    } else {
      const config = await import('@atc/config');
      const harnessPlugins = await import('./plugins/shipped-harness-plugins');
      const resolved = await import('./resolve-remote-daemon');
      const host = await import('./create-remote-tui-host');

      const picked = resolved.resolveRemoteDaemon(
        config.loadConfig(harnessPlugins.SHIPPED_HARNESS_PLUGINS),
        daemon,
        config.configFile,
      );

      if (!picked.ok) {
        console.error(`atc: ${picked.message}`);
        process.exit(1);
      }

      await tui.runTUI(host.createRemoteTUIHost(lifecycleHost, picked.daemon));
    }
  },
  runMCP: async (flags) => {
    const boot = await import('@atc/lifecycle');
    const lifecycle = await import('./build-lifecycle-host');
    const hostServices = await resolveHostServices();

    const host = lifecycle.buildLifecycleHost(process.env, hostServices);

    if (!flags.http) {
      const server = await import('@atc/mcp/stdio');

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
        tokenFile: flags.tokenFile,
        allowedOrigins: flags.allowedOrigins,
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
  runDaemon: async (listen, tokenFile) => {
    const daemon = await import('./run-daemon');

    await daemon.runDaemon({
      listen,
      tokenFile,
      env: process.env,
      loadHostServices: resolveHostServices,
    });
  },
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
    const reporters = await import('@atc/reporters');

    await reporters.runHookReport(agent);
  },
  runTap: async (session, notices) => {
    const tap = await import('@atc/reporters/tap');
    const hostServices = await resolveHostServices();

    await tap.runTap(session, hostServices.build, { notices });
  },
  runNote: async (kind, options) => {
    const reporters = await import('@atc/reporters');

    await reporters.runNote(kind, options);
  },
  runStatusline: async (agent) => {
    const reporters = await import('@atc/reporters');

    await reporters.runStatusline(agent);
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
  const services = await import('./create-host-services');

  return services.createHostServices();
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

  const code = await sessionAction.runSessionAction(booted.client, {
    action,
    session: id,
    size: { cols: process.stdout.columns ?? 100, rows: process.stdout.rows ?? 30 },
  });

  booted.client.stop();

  return code;
}

await runATCCLI(process.argv.slice(2), ATC_CLI_IO);
