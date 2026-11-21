import { LOCAL_TARGET, parseConfig } from '@atc/config';
import { resolveATCCommand } from '@atc/core/test-utils/resolve-atc-command';
import { buildStubTargets } from '@atc/daemon/test-utils/build-stub-targets';
import { createStubAgentCLIs } from '@atc/daemon/test-utils/create-stub-agent-clis';
import { buildMockHostServices } from '@atc/plugin-api/test-utils/build-mock-host-services';
import { createTempDir } from '@zgeoff/testing/fs';
import { buildAgentAdapters } from '../agents/build-agent-adapters';
import { SHIPPED_HARNESS_PLUGINS } from '../plugins/shipped-harness-plugins';
import { startTestDaemon } from './start-test-daemon';

type StubAgentBins = ReturnType<typeof createStubAgentCLIs>['bins'];

interface StubAgentDaemonConfig {
  readonly agents?: (bins: StubAgentBins) => Readonly<Record<string, unknown>>;

  // How long a started session may go without a message tap before a
  // message to it is refused; the daemon's own default when absent.
  readonly tapGraceMs?: number;
}

export async function startStubAgentDaemon(config: StubAgentDaemonConfig = {}) {
  const temporaryDirectory = createTempDir('atc-stub-agents-');
  const agents = createStubAgentCLIs(temporaryDirectory.path);
  const entries = config.agents?.(agents.bins) ?? { claude: { bin: agents.bins.claude } };

  const daemon = await startTestDaemon({
    prefix: 'atc-stub-agent-daemon-',
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, { agents: entries }),
        buildMockHostServices({ atcArgv: resolveATCCommand() }),
      ),
      targets: buildStubTargets([LOCAL_TARGET], { spawned: [], onStart: agents.start }),
      homeDir: temporaryDirectory.path,
      ...(config.tapGraceMs === undefined ? {} : { tapGraceMs: config.tapGraceMs }),
    }),
  });

  return { daemon, agents, home: temporaryDirectory.path };
}
