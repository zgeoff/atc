import { resolve } from 'node:path';
import type { RemoteDaemon } from '@atc/config';
import { parseListenAddress } from '@atc/config/host';
import type { HostServices } from '@atc/plugin-api';
import { readSessionEnv } from '@atc/protocol/session';
import { PROCESS_IO } from './cli/process-io';
import { runATCCLI } from './cli/run-atc-cli';
import type { ATCCLIIO } from './cli/run-atc-cli';

// Built on first use: hook and statusline commands never need these, so they start
// without loading the modules behind them.
let pendingHostServices: Promise<HostServices> | null = null;

const ATC_CLI_IO: ATCCLIIO = {
  ...PROCESS_IO,
  runTUI: async (daemon) => {
    const lifecycle = await import('./daemon/build-lifecycle-host');
    const tui = await import('@atc/tui');
    const hostServices = await resolveHostServices();

    const lifecycleHost = lifecycle.buildLifecycleHost(process.env, hostServices);

    if (daemon === null) {
      const host = await import('./tui/create-tui-host');

      await tui.runTUI(host.createTUIHost(lifecycleHost));
    } else {
      const host = await import('./tui/create-remote-tui-host');
      const picked = await readConfiguredDaemon(daemon, 'atc');

      if (picked === null) {
        return;
      }

      await tui.runTUI(host.createRemoteTUIHost(lifecycleHost, picked));
    }
  },
  runMCP: async (flags) => {
    const boot = await import('@atc/lifecycle');
    const lifecycle = await import('./daemon/build-lifecycle-host');
    const hostServices = await resolveHostServices();

    const host = lifecycle.buildLifecycleHost(process.env, hostServices);
    const build = host.invocation.readBuild();

    const named =
      flags.daemon === null ? null : await readConfiguredDaemon(flags.daemon, 'atc mcp');

    if (flags.daemon !== null && named === null) {
      return;
    }

    if (!flags.http) {
      const server = await import('@atc/mcp/stdio');

      if (named === null) {
        await server.runMCPServer(build, {
          kind: 'local',
          boot: () => boot.bootDaemonClient(host),
        });

        return;
      }

      const wiring = await import('./daemon-connection/connect-named-daemon');

      await server.runMCPServer(build, {
        kind: 'named',
        caller: wiring.connectNamedDaemon(named, build).caller,
      });

      return;
    }

    const http = await import('./mcp/run-mcp-http-server');
    const database = await import('./mcp/open-mcp-auth-database');

    const httpFlags = {
      host: flags.host,
      port: flags.port,
      publicURL: flags.publicURL,
      waitForDaemon: flags.waitForDaemon,
      tokenFile: flags.tokenFile,
      serviceTokenFile: flags.serviceTokenFile,
      allowedOrigins: flags.allowedOrigins,
    };

    if (named === null) {
      const connection = await import('./daemon-connection/create-local-daemon-connection');

      await http.runMCPHTTPServer(build, httpFlags, {
        bootDaemon: (options) => boot.bootDaemonClient(host, options),
        connectDaemon: (booted) => connection.createLocalDaemonConnection(booted.socketPath, build),
        openAuthDatabase: database.openMCPAuthDatabase,
      });

      return;
    }

    const remote = await import('./remote-daemon/boot-remote-daemon-client');
    const wiring = await import('./daemon-connection/connect-named-daemon');

    await http.runMCPHTTPServer(build, httpFlags, {
      bootDaemon: (options) => remote.bootRemoteDaemonClient(named, build, options),
      connectDaemon: () => wiring.connectNamedDaemon(named, build),
      openAuthDatabase: database.openMCPAuthDatabase,
    });
  },
  runMCPServiceSecret: async () => {
    const secret = await import('./service-token/run-service-secret');

    secret.runServiceSecret(PROCESS_IO);
  },
  runClients: async (action) => {
    const clients = await import('./auth/run-clients');
    const config = await import('@atc/config');

    await clients.runClients(action, { dbPath: config.mcpAuthDBFile, command: 'atc clients' });
  },
  runPasskeys: async (action) => {
    const passkeys = await import('./auth/run-passkeys');
    const config = await import('@atc/config');

    await passkeys.runPasskeys(action, { dbPath: config.mcpAuthDBFile, command: 'atc passkeys' });
  },
  runSession: async (action, id) => {
    const code = await runSessionCommand(action, id);

    process.exit(code);
  },
  runWorkspacesPrune: async (remove) => {
    const code = await runWorkspacesPruneCommand(remove);

    process.exit(code);
  },
  runGrants: async (revoke) => {
    const grants = await import('./auth/run-grants');

    await grants.runGrants(revoke);
  },
  runConfigMigrate: async (file, write) => {
    const migrate = await import('./config/run-config-migrate');
    const config = await import('@atc/config');

    const code = migrate.runConfigMigrate(file ?? config.configFile, write);

    if (code !== 0) {
      process.exit(code);
    }
  },
  runDaemon: async (listen, tokenFile) => {
    const daemon = await import('./daemon/run-daemon');

    await daemon.runDaemon({
      listen,
      tokenFile,
      env: process.env,
      loadHostServices: resolveHostServices,
    });
  },
  runDaemonID: async () => {
    const id = await import('@atc/lifecycle');
    const lifecycle = await import('./daemon/build-lifecycle-host');
    const hostServices = await resolveHostServices();

    await id.runDaemonID(lifecycle.buildLifecycleHost(process.env, hostServices));
  },
  runDaemonRestart: async (flags) => {
    const options = parseRestartFlags(flags);

    const restart = await import('@atc/lifecycle');
    const lifecycle = await import('./daemon/build-lifecycle-host');
    const hostServices = await resolveHostServices();

    const host = lifecycle.buildLifecycleHost(process.env, hostServices);

    const code = await restart.runDaemonRestart(host, { ...options, dryRun: flags.dryRun });

    process.exit(code);
  },
  runDaemonRestartWorker: async (flags) => {
    const options = parseRestartFlags(flags);

    const worker = await import('@atc/lifecycle');
    const lifecycle = await import('./daemon/build-lifecycle-host');
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
    const lifecycle = await import('./daemon/build-lifecycle-host');
    const hostServices = await resolveHostServices();

    const code = await backup.runDaemonBackup(
      lifecycle.buildLifecycleHost(process.env, hostServices),
      resolve(path),
    );

    process.exit(code);
  },
  runEvents: async () => {
    const events = await import('./events/run-events');

    await events.runEvents();
  },
  runSend: async (request) => {
    const send = await import('./send/run-send');
    const dependencies = await readSendDependencies();

    const code = await send.runSend(request, {
      ...dependencies,
      insideSession: readSessionEnv(process.env).sessionID !== undefined,
      readStdin: () => Bun.stdin.text(),
      isStdinTTY: process.stdin.isTTY,
      mintKey: () => `atc-send-${crypto.randomUUID()}`,
    });

    process.exit(code);
  },
  runMessageGet: async (request) => {
    const get = await import('./message-get/run-message-get');
    const dependencies = await readSendDependencies();
    const code = await get.runMessageGet(request, dependencies);

    process.exit(code);
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
  runRelayMux: async (socket) => {
    const mux = await import('@atc/reporters/relay-mux');

    await mux.runRelayMux(socket);
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

function resolveHostServices(): Promise<HostServices> {
  pendingHostServices ??= loadHostServices();

  return pendingHostServices;
}

async function loadHostServices(): Promise<HostServices> {
  const services = await import('./daemon/create-host-services');

  return services.createHostServices();
}

async function readConfiguredDaemon(name: string, command: string): Promise<RemoteDaemon | null> {
  const config = await import('@atc/config');
  const harnessPlugins = await import('./plugins/shipped-harness-plugins');
  const reader = await import('./daemon-connection/read-named-daemon');

  return reader.readNamedDaemon(name, command, {
    loadConfig: () => config.loadConfig(harnessPlugins.SHIPPED_HARNESS_PLUGINS),
    configFile: config.configFile,
    io: PROCESS_IO,
  });
}

// Connecting here must never start a daemon.
async function readSendDependencies() {
  const opener = await import('./send/open-send-connection');
  const config = await import('@atc/config');
  const host = await import('@atc/config/host');
  const harnessPlugins = await import('./plugins/shipped-harness-plugins');
  const resolver = await import('./remote-daemon/resolve-remote-daemon');
  const std = await import('@zgeoff/std');
  const hostServices = await resolveHostServices();

  return {
    connect: (target: Parameters<typeof opener.openSendConnection>[0]) =>
      opener.openSendConnection(target, {
        socketPath: host.daemonSocketPath,
        build: hostServices.build,
        session: readSessionEnv(process.env).sessionID,
        resolveDaemon: (name) =>
          resolver.resolveRemoteDaemon(
            config.loadConfig(harnessPlugins.SHIPPED_HARNESS_PLUGINS),
            name,
            config.configFile,
          ),
      }),
    clock: std.systemClock,
    io: PROCESS_IO,
  };
}

// Reject bad flags here: the replacement daemon would refuse them only after
// the old daemon has already stopped, leaving no daemon running.
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

async function runWorkspacesPruneCommand(remove: boolean): Promise<number> {
  const boot = await import('@atc/lifecycle');
  const lifecycle = await import('./daemon/build-lifecycle-host');
  const prune = await import('./workspaces/run-workspaces-prune');
  const hostServices = await resolveHostServices();

  const booted = await boot.bootDaemonClient(
    lifecycle.buildLifecycleHost(process.env, hostServices),
  );

  const code = await prune.runWorkspacesPrune(booted.client, { remove });

  booted.client.stop();

  return code;
}

async function runSessionCommand(action: 'rebind' | 'adopt', id: string): Promise<number> {
  const boot = await import('@atc/lifecycle');
  const lifecycle = await import('./daemon/build-lifecycle-host');
  const sessionAction = await import('./cli/run-session-action');
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
