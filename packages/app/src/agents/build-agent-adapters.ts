import type { Config } from '@atc/config';
import type { ClaudeHeadlessRun, ClaudeHostPaths } from '@atc/harness-claude';
import type { AgentAdapter, HostServices } from '@atc/plugin-api';
import { buildHarnessPlugins } from '../plugins/build-harness-plugins';

interface AgentAdapterPaths extends ClaudeHostPaths {
  readonly bridgeTarget?: string;
}

export function buildAgentAdapters(
  config: Config,
  host: HostServices,
  headlessRun: ClaudeHeadlessRun | null = null,
  paths: AgentAdapterPaths = {},
): AgentAdapter[] {
  const plugins = buildHarnessPlugins({ ...paths, headlessRun });
  const context = { authProfiles: config.authProfiles };

  return config.agents.map((entry): AgentAdapter => {
    const plugin = plugins.find((candidate) => candidate.id === entry.kind);

    if (plugin === undefined) {
      throw new Error(`no harness plugin owns kind ${entry.kind}`);
    }

    return plugin.create({ entry, warnings: [] }, host, context);
  });
}
