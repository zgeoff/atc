import { basename } from 'node:path';
import {
  daemonPidFile,
  daemonSocketPath,
  dbFile,
  eventsSocketPath,
  loadConfig,
  mcpAuthDBFile,
  socketPath,
} from '@atc/config';
import { parseListenAddress, resolveHomeDir } from '@atc/config/host';
import { buildExecutionTargets, buildSources, startDaemon, startStderrLog } from '@atc/daemon';
import { startClaudeHeadlessRun } from '@atc/harness-claude';
import { makeDaemonReadySignal } from '@atc/lifecycle';
import type { HostServices } from '@atc/plugin-api';
import { registerRefusedSQLiteName } from '@atc/store/sqlite';
import { buildAgentAdapters } from './agents/build-agent-adapters';
import { formatDaemonConfigProblems } from './format-daemon-config-problems';
import { parseDaemonOverrides } from './parse-daemon-overrides';
import { createShippedExecutionProvider } from './plugins/create-shipped-execution-provider';
import { loadExecutionPlugins } from './plugins/load-execution-plugins';
import { SHIPPED_HARNESS_PLUGINS } from './plugins/shipped-harness-plugins';
import { createBuiltinSources } from './sources/create-builtin-sources';

interface DaemonInvocation {
  readonly listen: string | null;
  readonly tokenFile: string | null;
  readonly env: Record<string, string | undefined>;
  readonly loadHostServices: () => Promise<HostServices>;
}

export async function runDaemon(invocation: DaemonInvocation): Promise<void> {
  if ((invocation.listen === null) !== (invocation.tokenFile === null)) {
    console.error('atc daemon: --listen and --token-file go together');
    process.exit(1);
  }

  const listen = invocation.listen === null ? null : parseListenAddress(invocation.listen);

  if (listen !== null && !listen.ok) {
    console.error(`atc daemon: ${listen.message}`);
    process.exit(1);
  }

  const signalReady = makeDaemonReadySignal(invocation.env);

  // The daemon never opens the gateway's authorization database, by any
  // route, so an open of a file with its name fails in this process.
  registerRefusedSQLiteName(basename(mcpAuthDBFile));

  const hostServices = await invocation.loadHostServices();

  const config = loadConfig(SHIPPED_HARNESS_PLUGINS);

  const plugins = await loadExecutionPlugins(config.targets);

  const built = buildExecutionTargets(config.targets, (target) =>
    createShippedExecutionProvider(
      plugins,
      target,
      hostServices,
      invocation.env,
      config.authProfiles,
    ),
  );

  const targetErrors = [...config.targetErrors, ...built.errors];

  const sources = buildSources(
    createBuiltinSources({
      roots: config.dirs.roots,
      githubOwner: config.workspaces.githubOwner,
      ghBin: 'gh',
      homeDir: resolveHomeDir(),
      host: hostServices,
    }),
    config.workspaces.sources,
  );

  for (const line of formatDaemonConfigProblems(config, targetErrors, sources.missing)) {
    console.error(line);
  }

  const adapters = buildAgentAdapters(config, hostServices, startClaudeHeadlessRun);

  // The daemon's own lines go to stderr through LogTape, and a stop or a
  // quit stops the log before the process exits.
  const stderrLog = await startStderrLog();

  let handle: Awaited<ReturnType<typeof startDaemon>>;

  try {
    handle = await startDaemon({
      socketPath: daemonSocketPath,
      reporterSocketPath: socketPath,
      eventsSocketPath,
      build: hostServices.build,
      adapters,
      defaultAgent: config.defaultAgent,
      dbPath: dbFile,
      pidPath: daemonPidFile,
      hooks: config.hooks,
      targets: built.targets,
      defaultTarget: config.defaultTarget,
      targetErrors,
      principals: config.principals,
      sources: sources.sources,
      gitTransports: config.workspaces.gitTransports,
      workspaceRoots: { root: config.workspaces.root, targetRoots: config.workspaces.targetRoots },
      ...(listen === null || invocation.tokenFile === null
        ? {}
        : { listen: { host: listen.host, port: listen.port, tokenFile: invocation.tokenFile } }),
      restoreFleetOnRestart: config.restoreFleetOnRestart,
      ...parseDaemonOverrides(invocation.env),
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

  signalReady();

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
