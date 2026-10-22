import { loadConfig } from '@atc/config';
import { resolvePaths } from '@atc/config/host';
import { buildExecutionTargets, buildSources, startDaemon } from '@atc/daemon';
import type { DaemonHandle } from '@atc/daemon';
import { registerTestCleanup, updateEnv, waitFor } from '@atc/test-utils';
import type { TUIHarness } from '@atc/test-utils';
import { buildAgentAdapters } from '../agents/build-agent-adapters';
import { createHostServices } from '../create-host-services';
import { createShippedExecutionProvider } from '../plugins/create-shipped-execution-provider';
import { SHIPPED_HARNESS_PLUGINS } from '../plugins/shipped-harness-plugins';
import { createBuiltinSources } from '../sources/create-builtin-sources';

// Starts in the test's process the daemon that a client booted in the
// harness home would start, on the home's config, sockets and state, so the
// client attaches to it instead of loading a daemon process of its own.
export async function startTUIDaemon(
  tui: Pick<TUIHarness, 'env' | 'home' | 'stop'>,
): Promise<DaemonHandle> {
  // A local session takes this process's environment, and the stand-in
  // agents read their scenario files from the HOME it holds.
  for (const name of ['HOME', 'XDG_RUNTIME_DIR', 'PATH'] as const) {
    updateEnv(name, tui.env[name]);
  }

  const paths = resolvePaths(tui.env);
  const host = createHostServices({ log: () => {} });
  const config = loadConfig(SHIPPED_HARNESS_PLUGINS, paths.configFile, tui.home, paths.stateDir);

  const targets = buildExecutionTargets(config.targets, (target) =>
    createShippedExecutionProvider(target, host, tui.env, config.authProfiles),
  );

  const sources = buildSources(
    createBuiltinSources({
      roots: config.dirs.roots,
      githubOwner: config.workspaces.githubOwner,
      ghBin: 'gh',
      homeDir: tui.home,
      host,
    }),
    config.workspaces.sources,
  );

  // No pid file, since the harness stops the daemon that file names, and
  // this daemon is the test's own process.
  const daemon = await startDaemon({
    socketPath: paths.daemonSocketPath,
    reporterSocketPath: paths.socketPath,
    eventsSocketPath: paths.eventsSocketPath,
    statusPath: paths.statusFile,
    dbPath: paths.dbFile,
    build: host.build,
    adapters: buildAgentAdapters(config, host),
    defaultAgent: config.defaultAgent,
    targets: targets.targets,
    defaultTarget: config.defaultTarget,
    sources: sources.sources,
    gitTransports: config.workspaces.gitTransports,
    workspaceRoots: { root: config.workspaces.root, targetRoots: config.workspaces.targetRoots },
    homeDir: tui.home,
    log: () => {},
  });

  // A client that sees its daemon go starts a daemon process of its own, so
  // the harness kills the client and the daemon waits until its connection
  // closes before it stops.
  registerTestCleanup(async () => {
    await tui.stop();

    await waitFor(
      () => {
        if (daemon.countClients() > 0) {
          throw new Error('a client is still connected');
        }
      },
      { timeoutMs: 1000 },
    ).catch(() => {});

    await daemon.stop();
  });

  return daemon;
}
