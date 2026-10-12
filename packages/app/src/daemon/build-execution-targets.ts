import type { TargetConfig, TargetConfigError } from '@atc/config/collect-targets';
import type { ExecutionProvider } from '@atc/plugin-api/execution-provider';
import type { HostServices } from '@atc/plugin-api/host-services';
import { TargetUnavailableError } from '@atc/plugin-api/target-unavailable-error';
import { buildTargetIdentity } from '@atc/store/build-target-identity';
import { createPluginContract } from '../plugins/create-plugin-contract';
import { SHIPPED_EXECUTION_PLUGINS } from '../plugins/shipped-execution-plugins';

/**
 * A configured place sessions run, with the provider that serves it. The
 * provider is null when this daemon has no provider of the configured kind:
 * the target still lists, and a spawn to it fails rather than running
 * anywhere else.
 */
export interface ExecutionTarget {
  readonly id: string;
  readonly kind: string;
  readonly options: Readonly<Record<string, unknown>>;

  // The identity a session spawned here binds to.
  readonly identity: string;
  readonly provider: ExecutionProvider | null;
}

/**
 * The targets the daemon serves, and the problems with their entries that
 * only the daemon's environment shows.
 */
interface ExecutionTargetsBuild {
  readonly targets: ExecutionTarget[];
  readonly errors: TargetConfigError[];
}

/**
 * Builds one target per configured entry, in config order, each with a
 * provider from the shipped execution plugin its kind selects, when this
 * daemon ships one. The host's services hold the atc version the daemon
 * runs, which an imp's atc must match. An entry whose provider cannot
 * start from `env` keeps no provider and adds a target error.
 */
export function buildExecutionTargets(
  configs: readonly TargetConfig[],
  host: HostServices,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExecutionTargetsBuild {
  const errors: TargetConfigError[] = [];

  const targets = configs.map((config) => {
    const built = buildProvider(config, host, env);

    if (built.problem !== null) {
      errors.push({ scope: 'target', target: config.id, problem: built.problem });
    }

    return {
      id: config.id,
      kind: config.provider,
      options: config.options,
      identity: buildTargetIdentity(config.provider, config.options),
      provider: built.provider,
    };
  });

  return { targets, errors };
}

// The target's provider, or none with the problem its plugin reports.
function buildProvider(
  config: TargetConfig,
  host: HostServices,
  env: Readonly<Record<string, string | undefined>>,
): Readonly<{ provider: ExecutionProvider | null; problem: string | null }> {
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
