import type { TargetConfig } from '@atc/config';
import type { ProviderBuild } from '@atc/daemon';
import type { HostServices } from '@atc/plugin-api';
import { TargetUnavailableError } from '@atc/plugin-api';
import { createPluginContract } from './create-plugin-contract';
import { SHIPPED_EXECUTION_PLUGINS } from './shipped-execution-plugins';

export function buildShippedExecutionProvider(
  config: TargetConfig,
  host: HostServices,
  env: Readonly<Record<string, string | undefined>>,
): ProviderBuild {
  const plugin = SHIPPED_EXECUTION_PLUGINS.find((candidate) => candidate.id === config.provider);

  if (plugin === undefined) {
    return { provider: null, problem: null };
  }

  try {
    const provider = createPluginContract({
      plugin,
      raw: { id: config.id, options: config.options, env },
      entryID: config.id,
      host,
      context: { authProfiles: new Map() },
    });

    return { provider, problem: null, identityRule: plugin.identity };
  } catch (error) {
    if (error instanceof TargetUnavailableError) {
      return { provider: null, problem: error.problem, identityRule: plugin.identity };
    }

    throw error;
  }
}
