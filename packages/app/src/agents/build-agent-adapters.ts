import type { Config } from '@atc/config';
import type { ClaudeHeadlessRun, ClaudeHostPaths } from '@atc/harness-claude';
import type { AgentAdapter, HostServices } from '@atc/plugin-api';
import { buildHarnessPlugins } from '../plugins/build-harness-plugins';

/**
 * Where the Claude and gateway adapters write their settings file and their
 * copy of the atc-bridge mod, and the home whose Claude config they read. A
 * field left out takes atc's state folder or the running user's home.
 */
interface AgentAdapterPaths extends ClaudeHostPaths {
  readonly bridgeTarget?: string;
}

/**
 * One adapter per registry entry, in registry order, each created by the
 * shipped harness plugin its kind selects. The Claude-family adapters run
 * the atc CLI that the host's argv runs. Throws for an entry whose kind no
 * shipped plugin owns, which a config the shipped plugins read never holds.
 */
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
