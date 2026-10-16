import type { TargetConfig } from '@atc/config';
import type { ExecutionProvider, HostServices } from '@atc/plugin-api';
import { TargetUnavailableError } from '@atc/plugin-api';
import { createPluginContract } from './create-plugin-contract';
import { SHIPPED_EXECUTION_PLUGINS } from './shipped-execution-plugins';

/**
 * Builds a target entry's provider from the shipped execution plugin its
 * kind selects, or none when this build ships no such plugin. The host's
 * services hold the atc version the daemon runs, which an imp's atc must
 * match. A provider that cannot start from `env` gives none, with the
 * problem its plugin reports.
 */
export function buildShippedExecutionProvider(
  config: TargetConfig,
  host: HostServices,
  env: Readonly<Record<string, string | undefined>>,
): { readonly provider: ExecutionProvider | null; readonly problem: string | null } {
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

    return { provider, problem: null };
  } catch (error) {
    if (error instanceof TargetUnavailableError) {
      return { provider: null, problem: error.problem };
    }

    throw error;
  }
}
