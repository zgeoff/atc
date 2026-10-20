import type { TargetConfig } from '@atc/config';
import type { ProviderBuild } from '@atc/daemon';
import type { AuthProfile, HostServices } from '@atc/plugin-api';
import { TargetUnavailableError } from '@atc/plugin-api';
import { z } from 'zod';
import { createPluginContract } from './create-plugin-contract';
import { SHIPPED_EXECUTION_PLUGINS } from './shipped-execution-plugins';

export function createShippedExecutionProvider(
  config: TargetConfig,
  host: HostServices,
  env: Readonly<Record<string, string | undefined>>,
  authProfiles: ReadonlyMap<string, AuthProfile>,
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
      context: { authProfiles },
    });

    return { provider, problem: null, identityRule: plugin.identity };
  } catch (error) {
    if (error instanceof TargetUnavailableError) {
      return { provider: null, problem: error.problem, identityRule: plugin.identity };
    }

    // a plugin's schema states each problem in full, with the target's id
    if (error instanceof z.ZodError) {
      return {
        provider: null,
        problem: error.issues.map((issue) => issue.message).join('; '),
        identityRule: plugin.identity,
      };
    }

    throw error;
  }
}
