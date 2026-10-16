import type { TargetConfig, TargetConfigError } from '@atc/config';
import type { ExecutionProvider } from '@atc/plugin-api';
import { buildTargetIdentity } from '@atc/store';

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
 * The provider a target entry gets, or none, with the problem that kept it
 * from starting when there is one.
 */
export interface ProviderBuild {
  readonly provider: ExecutionProvider | null;
  readonly problem: string | null;
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
 * Builds one target per configured entry, in config order, each with the
 * provider `buildProvider` gives its entry. An entry whose provider reports
 * a problem keeps no provider and adds a target error.
 */
export function buildExecutionTargets(
  configs: readonly TargetConfig[],
  buildProvider: (config: TargetConfig) => ProviderBuild,
): ExecutionTargetsBuild {
  const errors: TargetConfigError[] = [];

  const targets = configs.map((config) => {
    const built = buildProvider(config);

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
