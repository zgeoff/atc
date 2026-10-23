import type { TargetConfig } from '@atc/config';
import type { ProviderBuild } from '@atc/daemon';
import type { AuthProfile, HostServices } from '@atc/plugin-api';
import { TargetUnavailableError } from '@atc/plugin-api';
import { z } from 'zod';
import { createPluginContract } from './create-plugin-contract';
import type { ExecutionPlugin } from './shipped-execution-plugins';

interface CreateShippedExecutionProviderOptions {
  readonly plugins: readonly ExecutionPlugin[];
  readonly config: TargetConfig;
  readonly host: HostServices;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly authProfiles: ReadonlyMap<string, AuthProfile>;
}

export function createShippedExecutionProvider(
  options: CreateShippedExecutionProviderOptions,
): ProviderBuild {
  const plugin = options.plugins.find((candidate) => candidate.id === options.config.provider);

  if (plugin === undefined) {
    return { provider: null, problem: null };
  }

  try {
    const provider = createPluginContract({
      plugin,
      raw: { id: options.config.id, options: options.config.options, env: options.env },
      entryID: options.config.id,
      host: options.host,
      context: { authProfiles: options.authProfiles },
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
