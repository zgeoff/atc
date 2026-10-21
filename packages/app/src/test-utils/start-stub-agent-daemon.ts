import { LOCAL_TARGET, parseConfig } from '@atc/config';
import { buildStubTargets, createStubAgentCLIs } from '@atc/daemon/testing';
import { buildMockHostServices, setupTempDir } from '@atc/test-utils';
import { buildAgentAdapters } from '../agents/build-agent-adapters';
import { SHIPPED_HARNESS_PLUGINS } from '../plugins/shipped-harness-plugins';
import { startTestDaemon } from './start-test-daemon';

type StubAgentBins = ReturnType<typeof createStubAgentCLIs>['bins'];

interface StubAgentDaemonConfig {
  // The config's agents map, built from the stand-in executables; one
  // Claude entry when absent.
  readonly agents?: (bins: StubAgentBins) => Readonly<Record<string, unknown>>;

  // How long a started session may go without a message tap before a
  // message to it is refused; the daemon's own default when absent.
  readonly tapGraceMs?: number;
}

// A daemon in the test's process whose agents are the in-process stand-in
// CLIs on its local target, so no session starts a process.
export async function startStubAgentDaemon(config: StubAgentDaemonConfig = {}) {
  const temporaryDirectory = setupTempDir('atc-stub-agents-');
  const agents = createStubAgentCLIs(temporaryDirectory.path);
  const entries = config.agents?.(agents.bins) ?? { claude: { bin: agents.bins.claude } };

  const daemon = await startTestDaemon({
    prefix: 'atc-stub-agent-daemon-',
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, { agents: entries }),
        buildMockHostServices(),
      ),
      targets: buildStubTargets([LOCAL_TARGET], { spawned: [], onStart: agents.start }),
      homeDir: temporaryDirectory.path,
      ...(config.tapGraceMs === undefined ? {} : { tapGraceMs: config.tapGraceMs }),
    }),
  });

  return { daemon, agents, home: temporaryDirectory.path };
}
