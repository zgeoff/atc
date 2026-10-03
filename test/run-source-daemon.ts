import { ClaudeAdapter } from '../src/agents/claude-adapter';
import { startClaudeHeadlessRun } from '../src/agents/start-claude-headless-run';
import { buildExecutionTargets } from '../src/daemon/build-execution-targets';
import { startDaemon } from '../src/daemon/daemon';
import { collectZoxideDirs } from '../src/shared/collect-zoxide-dirs';
import {
  daemonPidFile,
  daemonSocketPath,
  dbFile,
  eventsSocketPath,
  loadConfig,
  socketPath,
} from '../src/shared/config';
import { getBuild } from '../src/shared/get-build';
import { resolveHomeDir } from '../src/shared/resolve-home-dir';
import { buildSources } from '../src/sources/build-sources';
import { collectBuiltinSources } from '../src/sources/collect-builtin-sources';
import type { SourceProvider } from '../src/sources/types';

/**
 * Runs a daemon for the e2e suite, composed as `atc daemon` composes its
 * own from the config, the home, and the runtime directory, but with the
 * sources `ATC_TEST_SOURCES` selects: `fixture` offers the built-in sources
 * and then a source of git repositories that lists the one repository at
 * `ATC_TEST_FIXTURE_URL`, and `none` offers no sources, as a daemon from
 * before sources does. It prints `up` once it listens, and SIGTERM stops
 * it.
 */
async function main() {
  const config = loadConfig();

  const adapter = new ClaudeAdapter(config, startClaudeHeadlessRun);

  const builtin = buildSources(
    collectBuiltinSources({
      roots: config.dirs.roots,
      githubOwner: config.workspaces.githubOwner,
      ghBin: 'gh',
      homeDir: resolveHomeDir(),
      collectZoxideDirs,
    }),
    config.workspaces.sources,
  ).sources;

  const fixture: SourceProvider = {
    id: 'fixture',
    label: 'fixture repository',
    kind: 'git',
    list: () =>
      Promise.resolve({
        candidates: [
          {
            label: 'upstream',
            detail: 'fixture',
            pick: { kind: 'git', url: process.env['ATC_TEST_FIXTURE_URL'] ?? '' },
          },
        ],
        scope: null,
      }),
    interpret: () => Promise.resolve({ kind: 'none' }),
  };

  const handle = await startDaemon({
    socketPath: daemonSocketPath,
    reporterSocketPath: socketPath,
    eventsSocketPath,
    build: getBuild(),
    adapter,
    adapters: [adapter],
    dbPath: dbFile,
    pidPath: daemonPidFile,
    targets: buildExecutionTargets(config.targets).targets,
    defaultTarget: config.defaultTarget,
    sources: process.env['ATC_TEST_SOURCES'] === 'none' ? [] : [...builtin, fixture],
  });

  process.stdout.write('up\n');

  process.on('SIGTERM', () => {
    void (async () => {
      await handle.stop();

      process.exit(0);
    })();
  });
}

await main();
