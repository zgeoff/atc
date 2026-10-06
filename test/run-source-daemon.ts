import { appendFileSync } from 'node:fs';
import { buildAgentAdapters } from '../src/agents/build-agent-adapters';
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
 * before sources does. The fixture source reads `pick upstream` as that
 * repository and `in <scope>` as a scope to list, and appends each listing
 * it serves to `ATC_TEST_SOURCE_LOG` when that is set. It prints `up` once it listens, and SIGTERM stops
 * it.
 */
async function main() {
  const config = loadConfig();
  const adapters = buildAgentAdapters(config, startClaudeHeadlessRun);

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

  const fixtureURL = process.env['ATC_TEST_FIXTURE_URL'] ?? '';
  const listLog = process.env['ATC_TEST_SOURCE_LOG'];

  const fixture: SourceProvider = {
    id: 'fixture',
    label: 'fixture repository',
    kind: 'git',
    list: (query, request) => {
      if (listLog !== undefined) {
        appendFileSync(
          listLog,
          `${JSON.stringify({ scope: query.scope ?? null, target: request.target })}\n`,
        );
      }

      const label = query.scope === undefined ? 'upstream' : `${query.scope}/upstream`;

      return Promise.resolve({
        candidates: [{ label, detail: 'fixture', pick: { kind: 'git', url: fixtureURL } }],
        scope: query.scope ?? null,
      });
    },
    interpret: (input) => {
      const text = input.trim();

      if (text === 'pick upstream') {
        return Promise.resolve({ kind: 'git', url: fixtureURL });
      }

      if (text.startsWith('in ')) {
        return Promise.resolve({ kind: 'browse', scope: text.slice(3) });
      }

      return Promise.resolve({ kind: 'none' });
    },
  };

  const handle = await startDaemon({
    socketPath: daemonSocketPath,
    reporterSocketPath: socketPath,
    eventsSocketPath,
    build: getBuild(),
    adapters,
    defaultAgent: config.defaultAgent,
    dbPath: dbFile,
    pidPath: daemonPidFile,
    targets: buildExecutionTargets(config.targets).targets,
    defaultTarget: config.defaultTarget,
    sources: process.env['ATC_TEST_SOURCES'] === 'none' ? [] : [...builtin, fixture],
    gitTransports: config.workspaces.gitTransports,
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
