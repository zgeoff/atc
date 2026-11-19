import type { TargetConfig } from '@atc/config';
import type { ProviderBuild } from '@atc/daemon';
import type { AuthProfile, ExecutionHostServices, HostServices } from '@atc/plugin-api';
import { TargetUnavailableError } from '@atc/plugin-api';
import { z } from 'zod';
import { createPluginContract } from './create-plugin-contract';
import { createProviderStateDir } from './create-provider-state-dir';
import type { ExecutionPlugin } from './shipped-execution-plugins';

interface CreateShippedExecutionProviderOptions {
  readonly plugins: readonly ExecutionPlugin[];
  readonly config: TargetConfig;
  readonly host: HostServices;

  readonly stateDir: string;
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

  const providerDir = createProviderStateDir(options.stateDir, options.config.id);

  if (providerDir === null) {
    return {
      provider: null,
      problem: `target ${JSON.stringify(options.config.id)} cannot name a folder of its own`,
      identityRule: plugin.identity,
    };
  }

  const host = options.host;

  const services: ExecutionHostServices = {
    atcArgv: host.atcArgv,
    version: host.version,

    // a getter, so a long-lived process reads the stamp a rebuild leaves
    get build() {
      return host.build;
    },
    runCommand: host.runCommand,
    clock: host.clock,
    log: host.log,
    stateDir: providerDir,
  };

  try {
    const provider = createPluginContract({
      plugin,
      raw: { id: options.config.id, options: options.config.options, env: options.env },
      entryID: options.config.id,
      host: services,
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
